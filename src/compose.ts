import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { FeaturePhaseOrchestrator, promptLibrary } from '@agents';
import { type ApplicationLifecycle, GvcApplication } from '@app/index';
import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  AppMode,
  FeatureId,
  MilestoneId,
} from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { IntegrationReconciler } from '@orchestrator/integration/reconciler';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import {
  RecoveryService,
  VerificationService,
} from '@orchestrator/services/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { SqliteStore } from '@persistence/sqlite-store';
import { JsonConfigLoader } from '@root/config';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
  RuntimePort,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import {
  DiscussFeaturePhaseBackend,
  PiSdkHarness,
} from '@runtime/harness/index';
import { FileSessionStore } from '@runtime/sessions/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { GitWorktreeProvisioner } from '@runtime/worktree/index';
import { TuiApp } from '@tui/app';

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

export async function composeApplication(): Promise<GvcApplication> {
  const projectRoot = process.cwd();
  await ensureRuntimeDirs(projectRoot);

  const config = await new JsonConfigLoader().load();
  const db = openDatabase(path.join(projectRoot, '.gvc0', 'state.db'));
  const graph = new PersistentFeatureGraph(db);
  const store = new SqliteStore(db);
  const sessionStore = new FileSessionStore(projectRoot);
  const maxWorkers = Math.max(1, os.availableParallelism());

  const schedulerRef: { current: SchedulerLoop | undefined } = {
    current: undefined,
  };
  const stopApplicationRef: { current: (() => Promise<void>) | undefined } = {
    current: undefined,
  };

  const ui: TuiApp = new TuiApp({
    snapshot: () => graph.snapshot(),
    listAgentRuns: () => store.listAgentRuns(),
    getWorkerCounts: () => {
      const idleWorkers = runtime.idleWorkerCount();
      return {
        runningWorkers: Math.max(0, maxWorkers - idleWorkers),
        idleWorkers,
        totalWorkers: maxWorkers,
      };
    },
    isAutoExecutionEnabled: () =>
      schedulerRef.current?.isAutoExecutionEnabled() ?? false,
    setAutoExecutionEnabled: (enabled) => {
      return schedulerRef.current?.setAutoExecutionEnabled(enabled) ?? enabled;
    },
    toggleAutoExecution: () => {
      const next = !(schedulerRef.current?.isAutoExecutionEnabled() ?? false);
      return schedulerRef.current?.setAutoExecutionEnabled(next) ?? next;
    },
    toggleMilestoneQueue: (milestoneId) => {
      const milestone = graph
        .snapshot()
        .milestones.find((entry) => entry.id === milestoneId);
      if (milestone?.steeringQueuePosition !== undefined) {
        graph.dequeueMilestone(milestoneId);
        return;
      }
      graph.queueMilestone(milestoneId);
    },
    initializeProject: (input) => {
      return initializeProjectGraph(graph, input);
    },
    cancelFeature: async (featureId) => {
      await cancelFeatureRunWork({ graph, store, runtime }, featureId);
    },
    saveFeatureRun: (run) => {
      const existing = store.getAgentRun(run.id);
      if (existing === undefined) {
        store.createAgentRun(run);
        return;
      }
      store.updateAgentRun(run.id, {
        phase: run.phase,
        runStatus: run.runStatus,
        owner: run.owner,
        attention: run.attention,
        restartCount: run.restartCount,
        maxRetries: run.maxRetries,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(run.payloadJson !== undefined
          ? { payloadJson: run.payloadJson }
          : {}),
        ...(run.retryAt !== undefined ? { retryAt: run.retryAt } : {}),
      });
    },
    getFeatureRun: (featureId, phase) => {
      const run = store.getAgentRun(`run-feature:${featureId}:${phase}`);
      return run?.scopeType === 'feature_phase' ? run : undefined;
    },
    getTaskRun: (taskId) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      return run?.scopeType === 'task' ? run : undefined;
    },
    enqueueApprovalDecision: (event) => {
      schedulerRef.current?.enqueue({
        type: 'feature_phase_approval_decision',
        featureId: event.featureId,
        phase: event.phase,
        decision: event.decision,
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
      });
    },
    rerunFeatureProposal: (event) => {
      schedulerRef.current?.enqueue({
        type: 'feature_phase_rerun_requested',
        featureId: event.featureId,
        phase: event.phase,
      });
    },
    respondToTaskHelp: (taskId, response) =>
      respondToPendingTaskHelp(store, runtime, taskId, response),
    decideTaskApproval: (taskId, decision) =>
      decidePendingTaskApproval(store, runtime, taskId, decision),
    respondToFeaturePhaseHelp: async (featureId, phase, response) => {
      const runId = `run-feature:${featureId}:${phase}`;
      const run = store.getAgentRun(runId);
      if (run?.scopeType !== 'feature_phase') {
        throw new Error(`feature "${featureId}" has no ${phase} run`);
      }
      const pending = runtime.listPendingFeaturePhaseHelp(runId);
      const next = pending[0];
      if (next === undefined) {
        throw new Error(
          `feature "${featureId}" planner has no pending help request`,
        );
      }
      const result = await runtime.respondToRunHelp(
        runId,
        next.toolCallId,
        response,
      );
      if (result.kind !== 'delivered') {
        throw new Error(`feature "${featureId}" planner is not running`);
      }
      return `Sent help response to ${featureId} planner.`;
    },
    listPendingFeaturePhaseHelp: (featureId, phase) =>
      runtime.listPendingFeaturePhaseHelp(`run-feature:${featureId}:${phase}`),
    attachFeaturePhaseRun: (featureId, phase) =>
      attachFeaturePhaseRunImpl({ store, ui }, featureId, phase),
    releaseFeaturePhaseToScheduler: (featureId, phase) =>
      releaseFeaturePhaseToSchedulerImpl(
        { store, runtime, ui },
        featureId,
        phase,
      ),
    sendPlannerChatInput: async (featureId, phase, text) => {
      const runId = `run-feature:${featureId}:${phase}`;
      const run = store.getAgentRun(runId);
      if (run?.scopeType !== 'feature_phase') {
        throw new Error(`feature "${featureId}" has no ${phase} run`);
      }
      if (run.runStatus !== 'running') {
        throw new Error(
          `feature "${featureId}" planner is not running (status="${run.runStatus}")`,
        );
      }

      const result = await runtime.sendRunManualInput(run.id, text);
      if (result.kind !== 'delivered') {
        throw new Error(`feature "${featureId}" planner is not running`);
      }
      return `Sent chat to planner for ${featureId}.`;
    },
    sendTaskManualInput: async (taskId, text) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (run.runStatus !== 'running' || run.owner !== 'manual') {
        throw new Error(`task "${taskId}" is not open for manual input`);
      }

      const result = await runtime.sendRunManualInput(run.id, text);
      if (result.kind !== 'delivered') {
        throw new Error(`task "${taskId}" is not running`);
      }

      store.updateAgentRun(run.id, {
        runStatus: 'running',
        owner: 'manual',
      });
      return `Sent input to ${taskId}.`;
    },
    quit: async () => {
      await stopApplicationRef.current?.();
    },
  });

  const agents = new FeaturePhaseOrchestrator({
    modelId: config.modelRouting?.ceiling ?? DEFAULT_MODEL_ID,
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot,
    getApiKey,
    proposalOpSink: {
      onOpRecorded: (scope, op, draftSnapshot) => {
        ui.onProposalOp(scope, op, draftSnapshot);
      },
      onSubmitted: (scope, details, proposal, submissionIndex) => {
        ui.onProposalSubmitted(scope, details, proposal, submissionIndex);
      },
      onHelpRequested: (scope, toolCallId, query) => {
        // Persist await_response so existing TUI status badges + recovery
        // service see the help wait through the standard agent_runs surface.
        // Refresh UI immediately: scheduler tick is parked inside the long
        // dispatchFeaturePhaseRun await, so the next refresh would not run
        // until outcome resolves; without this nudge the TUI can miss the
        // live await_response transition.
        const runId = `run-feature:${scope.featureId}:${scope.phase}`;
        const run = store.getAgentRun(runId);
        if (run?.scopeType === 'feature_phase') {
          store.updateAgentRun(runId, {
            runStatus: 'await_response',
            payloadJson: JSON.stringify({ toolCallId, query }),
          });
          ui.refresh();
        }
      },
      onHelpResolved: (scope, _toolCallId) => {
        // Pending help drained; flip back to running unless the planner
        // already terminated (the phase-end hook resets ownership).
        const runId = `run-feature:${scope.featureId}:${scope.phase}`;
        const run = store.getAgentRun(runId);
        if (
          run?.scopeType === 'feature_phase' &&
          run.runStatus === 'await_response'
        ) {
          store.updateAgentRun(runId, {
            runStatus: 'running',
            payloadJson: undefined,
          });
          ui.refresh();
        }
      },
      onPhaseEnded: (scope, outcome) => {
        // Clear attention='operator' on outcome: the agent is gone, so the
        // attached marker is meaningless. Owner is reset by downstream
        // persistAwaitingApprovalFeaturePhaseRun (await_approval keeps
        // manual for the approval flow) or by the scheduler error path
        // (failed → system).
        const runId = `run-feature:${scope.featureId}:${scope.phase}`;
        const run = store.getAgentRun(runId);
        if (
          run?.scopeType === 'feature_phase' &&
          run.attention === 'operator'
        ) {
          store.updateAgentRun(runId, { attention: 'none' });
        }
        ui.onProposalPhaseEnded(scope, outcome);
      },
    },
  });
  const verification = new VerificationService({ config }, projectRoot);
  const runtime = new LocalWorkerPool(
    new PiSdkHarness(sessionStore, projectRoot),
    maxWorkers,
    (message) => {
      const workerOutput = formatWorkerOutput(message);
      if (workerOutput !== undefined) {
        ui.onWorkerOutput(message.agentRunId, message.taskId, workerOutput);
      }
      schedulerRef.current?.enqueue({ type: 'worker_message', message });
    },
    new DiscussFeaturePhaseBackend(graph, agents, verification, sessionStore),
    config,
  );
  const worktree = new GitWorktreeProvisioner(projectRoot);
  const ports: OrchestratorPorts = {
    store,
    runtime,
    sessionStore,
    verification,
    worktree,
    ui,
    config,
    projectRoot,
  };

  const scheduler = new SchedulerLoop(graph, ports);
  const recovery = new RecoveryService(ports, graph, projectRoot);
  const reconciler = new IntegrationReconciler({
    ports,
    graph,
    features: new FeatureLifecycleCoordinator(graph),
    cwd: projectRoot,
  });
  schedulerRef.current = scheduler;

  const app = new GvcApplication(ports, {
    prepare: (mode: AppMode) => {
      scheduler.setAutoExecutionEnabled(mode === 'auto');
    },
    start: async () => {
      await recovery.recoverOrphanedRuns();
      await reconciler.reconcile();
      await scheduler.run();
      ui.refresh();
    },
    stop: async () => {
      try {
        await scheduler.stop();
      } finally {
        db.close();
      }
    },
  } satisfies ApplicationLifecycle);
  stopApplicationRef.current = () => app.stop();
  return app;
}

async function ensureRuntimeDirs(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, '.gvc0'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, '.gvc0', 'worktrees'), {
    recursive: true,
  });
}

export async function respondToPendingTaskHelp(
  store: Pick<OrchestratorPorts['store'], 'getAgentRun' | 'updateAgentRun'>,
  runtime: Pick<RuntimePort, 'respondToRunHelp'>,
  taskId: string,
  response: HelpResponse,
): Promise<string> {
  const run = store.getAgentRun(`run-task:${taskId}`);
  if (run?.scopeType !== 'task') {
    throw new Error(`task "${taskId}" has no run`);
  }
  if (run.runStatus !== 'await_response') {
    throw new Error(`task "${taskId}" is not waiting for help`);
  }

  const toolCallId = parsePendingTaskToolCallId(taskId, run.payloadJson);
  const result = await runtime.respondToRunHelp(run.id, toolCallId, response);
  if (result.kind !== 'delivered') {
    throw new Error(`task "${taskId}" is not running`);
  }

  store.updateAgentRun(run.id, {
    runStatus: 'running',
    owner: 'manual',
    payloadJson: undefined,
  });
  return `Sent help response to ${taskId}.`;
}

export async function decidePendingTaskApproval(
  store: Pick<OrchestratorPorts['store'], 'getAgentRun' | 'updateAgentRun'>,
  runtime: Pick<RuntimePort, 'decideRunApproval'>,
  taskId: string,
  decision: ApprovalDecision,
): Promise<string> {
  const run = store.getAgentRun(`run-task:${taskId}`);
  if (run?.scopeType !== 'task') {
    throw new Error(`task "${taskId}" has no run`);
  }
  if (run.runStatus !== 'await_approval') {
    throw new Error(`task "${taskId}" is not waiting for approval`);
  }

  const toolCallId = parsePendingTaskToolCallId(taskId, run.payloadJson);
  const result = await runtime.decideRunApproval(run.id, toolCallId, decision);
  if (result.kind !== 'delivered') {
    throw new Error(`task "${taskId}" is not running`);
  }

  store.updateAgentRun(run.id, {
    runStatus: 'running',
    owner: 'manual',
    payloadJson: undefined,
  });
  return decision.kind === 'approved'
    ? `Approved ${taskId}.`
    : `Rejected ${taskId}.`;
}

export async function attachFeaturePhaseRunImpl(
  deps: {
    store: Pick<
      OrchestratorPorts['store'],
      'getAgentRun' | 'updateAgentRun' | 'appendEvent'
    >;
    ui: Pick<OrchestratorPorts['ui'], 'refresh'>;
  },
  featureId: string,
  phase: 'plan' | 'replan',
): Promise<string> {
  const runId = `run-feature:${featureId}:${phase}`;
  const run = deps.store.getAgentRun(runId);
  if (run?.scopeType !== 'feature_phase') {
    deps.store.appendEvent({
      eventType: 'feature_phase_attach_rejected',
      entityId: featureId,
      timestamp: Date.now(),
      payload: { phase, reason: 'not_running' },
    });
    throw new Error(`feature "${featureId}" has no ${phase} run`);
  }
  if (run.runStatus !== 'running' && run.runStatus !== 'await_response') {
    deps.store.appendEvent({
      eventType: 'feature_phase_attach_rejected',
      entityId: featureId,
      timestamp: Date.now(),
      payload: { phase, reason: 'not_running', runStatus: run.runStatus },
    });
    throw new Error(
      `feature "${featureId}" planner is not live (status="${run.runStatus}")`,
    );
  }
  if (run.owner === 'manual') {
    deps.store.appendEvent({
      eventType: 'feature_phase_attach_rejected',
      entityId: featureId,
      timestamp: Date.now(),
      payload: { phase, reason: 'already_manual' },
    });
    throw new Error(`feature "${featureId}" planner is already attached`);
  }
  deps.store.updateAgentRun(runId, {
    owner: 'manual',
    attention: 'operator',
  });
  deps.store.appendEvent({
    eventType: 'feature_phase_attached',
    entityId: featureId,
    timestamp: Date.now(),
    payload: { phase },
  });
  deps.ui.refresh();
  return Promise.resolve(`Attached to ${featureId} planner.`);
}

export async function releaseFeaturePhaseToSchedulerImpl(
  deps: {
    store: Pick<
      OrchestratorPorts['store'],
      'getAgentRun' | 'updateAgentRun' | 'appendEvent'
    >;
    runtime: Pick<RuntimePort, 'listPendingFeaturePhaseHelp'>;
    ui: Pick<OrchestratorPorts['ui'], 'refresh'>;
  },
  featureId: string,
  phase: 'plan' | 'replan',
): Promise<string> {
  const runId = `run-feature:${featureId}:${phase}`;
  const run = deps.store.getAgentRun(runId);
  if (run?.scopeType !== 'feature_phase') {
    deps.store.appendEvent({
      eventType: 'feature_phase_release_rejected',
      entityId: featureId,
      timestamp: Date.now(),
      payload: { phase, reason: 'not_attached' },
    });
    throw new Error(`feature "${featureId}" has no ${phase} run`);
  }
  if (run.owner !== 'manual' || run.attention !== 'operator') {
    deps.store.appendEvent({
      eventType: 'feature_phase_release_rejected',
      entityId: featureId,
      timestamp: Date.now(),
      payload: { phase, reason: 'not_attached' },
    });
    throw new Error(`feature "${featureId}" planner is not attached`);
  }
  if (run.runStatus === 'await_response') {
    const pending = deps.runtime.listPendingFeaturePhaseHelp(runId);
    const oldest = pending[0];
    deps.store.appendEvent({
      eventType: 'feature_phase_release_rejected',
      entityId: featureId,
      timestamp: Date.now(),
      payload: {
        phase,
        reason: 'pending_help',
        pendingToolCallIds: pending.map((entry) => entry.toolCallId),
      },
    });
    const detail =
      oldest !== undefined
        ? ` (pending: "${oldest.query}" — answer via /reply --text "...")`
        : ' (answer via /reply --text "..." before releasing)';
    throw new Error(
      `feature "${featureId}" has pending help; cannot release${detail}`,
    );
  }
  deps.store.updateAgentRun(runId, {
    owner: 'system',
    attention: 'none',
  });
  deps.store.appendEvent({
    eventType: 'feature_phase_released',
    entityId: featureId,
    timestamp: Date.now(),
    payload: { phase },
  });
  deps.ui.refresh();
  return Promise.resolve(`Released ${featureId} back to scheduler.`);
}

function parsePendingTaskToolCallId(
  taskId: string,
  payloadJson: string | undefined,
): string {
  if (payloadJson === undefined) {
    throw new Error(`task "${taskId}" is missing pending wait payload`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error(`task "${taskId}" has invalid pending wait payload`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    throw new Error(`task "${taskId}" is missing pending wait toolCallId`);
  }

  return (parsed as { toolCallId: string }).toolCallId;
}

export function initializeProjectGraph(
  graph: PersistentFeatureGraph,
  input: {
    milestoneName: string;
    milestoneDescription: string;
    featureName: string;
    featureDescription: string;
  },
): { milestoneId: MilestoneId; featureId: FeatureId } {
  const snapshot = graph.snapshot();
  if (snapshot.milestones.length > 0 || snapshot.features.length > 0) {
    throw new Error('project already initialized');
  }

  const milestoneId: MilestoneId = 'm-1';
  graph.createMilestone({
    id: milestoneId,
    name: input.milestoneName,
    description: input.milestoneDescription,
  });
  graph.queueMilestone(milestoneId);

  const featureId: FeatureId = 'f-1';
  graph.createFeature({
    id: featureId,
    milestoneId,
    name: input.featureName,
    description: input.featureDescription,
  });
  transitionFeatureToPlanning(graph, featureId);

  return { milestoneId, featureId };
}

function transitionFeatureToPlanning(
  graph: PersistentFeatureGraph,
  featureId: FeatureId,
): void {
  graph.transitionFeature(featureId, { status: 'in_progress' });
  graph.transitionFeature(featureId, { status: 'done' });
  graph.transitionFeature(featureId, {
    workControl: 'researching',
    status: 'pending',
  });
  graph.transitionFeature(featureId, { status: 'in_progress' });
  graph.transitionFeature(featureId, { status: 'done' });
  graph.transitionFeature(featureId, {
    workControl: 'planning',
    status: 'pending',
  });
}

export function formatWorkerOutput(
  message: WorkerToOrchestratorMessage,
): string | undefined {
  switch (message.type) {
    case 'progress':
      return message.message;
    case 'assistant_output':
      return message.text;
    case 'request_help':
      return `help requested: ${message.query}`;
    case 'request_approval':
      return `approval requested: ${summarizeApprovalPayload(message.payload)}`;
    case 'error':
      return `error: ${message.error}`;
    case 'result':
      return `completed: ${message.result.summary}`;
  }
}

interface CancelFeatureRunDeps {
  graph: Pick<FeatureGraph, 'tasks' | 'cancelFeature'>;
  store: {
    listAgentRuns: () => readonly AgentRun[];
    updateAgentRun: (runId: string, patch: Partial<AgentRun>) => void;
  };
  runtime: Pick<RuntimePort, 'abortRun'>;
}

export async function cancelFeatureRunWork(
  deps: CancelFeatureRunDeps,
  featureId: FeatureId,
): Promise<void> {
  const { graph, store, runtime } = deps;

  const featureTaskIds = new Set<string>();
  for (const task of graph.tasks.values()) {
    if (task.featureId === featureId) {
      featureTaskIds.add(task.id);
    }
  }

  const affectedRuns = store.listAgentRuns().filter((run) => {
    if (run.scopeType === 'task') {
      return featureTaskIds.has(run.scopeId);
    }
    return run.scopeType === 'feature_phase' && run.scopeId === featureId;
  });

  graph.cancelFeature(featureId);

  for (const run of affectedRuns) {
    const isTaskRunning =
      run.scopeType === 'task' && run.runStatus === 'running';
    const isFeaturePhaseLive =
      run.scopeType === 'feature_phase' &&
      (run.runStatus === 'running' || run.runStatus === 'await_response');
    if (isTaskRunning || isFeaturePhaseLive) {
      await runtime.abortRun(run.id);
    }
    store.updateAgentRun(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
      attention: 'none',
    });
  }
}

export function summarizeApprovalPayload(payload: ApprovalPayload): string {
  switch (payload.kind) {
    case 'custom':
      return payload.label;
    case 'destructive_action':
      return payload.description;
    case 'replan_proposal':
      return payload.summary;
  }
}

function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'google':
    case 'gemini':
      return process.env.GEMINI_API_KEY;
    default:
      return undefined;
  }
}
