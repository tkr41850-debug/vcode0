import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { type ApplicationLifecycle, GvcApplication } from '@app/index';
import type { AppMode, FeatureId, MilestoneId } from '@core/types/index';
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
  ApprovalPayload,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { PiSdkHarness } from '@runtime/harness/index';
import { FileSessionStore } from '@runtime/sessions/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
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

  const ui = new TuiApp({
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
    cancelFeature: (featureId) => {
      graph.cancelFeature(featureId);
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
    respondToTaskHelp: async (taskId, response) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (run.runStatus !== 'await_response') {
        throw new Error(`task "${taskId}" is not waiting for help`);
      }

      const result = await runtime.respondToHelp(taskId, response);
      if (result.kind !== 'delivered') {
        throw new Error(`task "${taskId}" is not running`);
      }

      store.updateAgentRun(run.id, {
        runStatus: 'running',
        owner: 'manual',
      });
      return `Sent help response to ${taskId}.`;
    },
    decideTaskApproval: async (taskId, decision) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (run.runStatus !== 'await_approval') {
        throw new Error(`task "${taskId}" is not waiting for approval`);
      }

      const result = await runtime.decideApproval(taskId, decision);
      if (result.kind !== 'delivered') {
        throw new Error(`task "${taskId}" is not running`);
      }

      store.updateAgentRun(run.id, {
        runStatus: 'running',
        owner: 'manual',
      });
      return decision.kind === 'approved'
        ? `Approved ${taskId}.`
        : `Rejected ${taskId}.`;
    },
    sendTaskManualInput: async (taskId, text) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (run.runStatus !== 'running' || run.owner !== 'manual') {
        throw new Error(`task "${taskId}" is not open for manual input`);
      }

      const result = await runtime.sendManualInput(taskId, text);
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
  );
  const agents = new PiFeatureAgentRuntime({
    modelId: config.modelRouting?.ceiling ?? DEFAULT_MODEL_ID,
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    getApiKey,
  });

  const verification = new VerificationService({ config }, projectRoot);
  const ports: OrchestratorPorts = {
    store,
    runtime,
    agents,
    verification,
    ui,
    config,
  };

  const scheduler = new SchedulerLoop(graph, ports);
  const recovery = new RecoveryService(ports, graph, projectRoot);
  schedulerRef.current = scheduler;

  const app = new GvcApplication(ports, {
    prepare: (mode: AppMode) => {
      scheduler.setAutoExecutionEnabled(mode === 'auto');
    },
    start: async () => {
      await recovery.recoverOrphanedRuns();
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
  graph.transitionFeature(featureId, { collabControl: 'branch_open' });
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
