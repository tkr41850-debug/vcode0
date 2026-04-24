import type { FeatureGraph } from '@core/graph/index';
import {
  buildCombinedGraph,
  computeGraphMetrics,
  type ExecutionRunReader,
  prioritizeReadyWork,
  type SchedulableUnit,
  schedulableUnitKey,
} from '@core/scheduling/index';
import type {
  AgentRun,
  AgentRunPhase,
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  Task,
  TaskAgentRun,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { isProposalPhase } from '@orchestrator/proposals/index';
import { buildTaskPayload } from '@runtime/context/index';
import type {
  DispatchRunResult,
  TaskRuntimeDispatch,
} from '@runtime/contracts';

import type { SchedulerEvent } from './index.js';

export function createRunReader(ports: OrchestratorPorts): ExecutionRunReader {
  const runs = ports.store.listAgentRuns();
  const byTaskId = new Map<string, AgentRun>();
  const byFeaturePhase = new Map<string, AgentRun>();

  for (const run of runs) {
    if (run.scopeType === 'task') {
      byTaskId.set(run.scopeId, run);
    } else {
      byFeaturePhase.set(`${run.scopeId}:${run.phase}`, run);
    }
  }

  return {
    getExecutionRun(
      scopeId: string,
      phase?: AgentRunPhase,
    ): AgentRun | undefined {
      if (phase !== undefined) {
        return byFeaturePhase.get(`${scopeId}:${phase}`);
      }
      return byTaskId.get(scopeId);
    },
  };
}

export function syncReadySince(
  readySince: Map<string, number>,
  units: readonly SchedulableUnit[],
  now: number,
): void {
  const nextKeys = new Set<string>();

  for (const unit of units) {
    const key = schedulableUnitKey(unit);
    nextKeys.add(key);
    if (!readySince.has(key)) {
      readySince.set(key, now);
    }
  }

  for (const key of readySince.keys()) {
    if (!nextKeys.has(key)) {
      readySince.delete(key);
    }
  }
}

export function ensureTaskRun(
  ports: OrchestratorPorts,
  task: Task,
): TaskAgentRun {
  const existing = ports.store.listAgentRuns({
    scopeType: 'task',
    scopeId: task.id,
    phase: 'execute',
  })[0];

  if (existing?.scopeType === 'task') {
    return existing;
  }

  const run: TaskAgentRun = {
    id: `run-task:${task.id}`,
    scopeType: 'task',
    scopeId: task.id,
    phase: 'execute',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
  };
  ports.store.createAgentRun(run);
  return run;
}

export function ensureFeaturePhaseRun(
  ports: OrchestratorPorts,
  feature: Feature,
  phase: AgentRunPhase,
): AgentRun {
  const existing = ports.store.listAgentRuns({
    scopeType: 'feature_phase',
    scopeId: feature.id,
    phase,
  })[0];

  if (existing !== undefined) {
    return existing;
  }

  const run: AgentRun = {
    id: `run-feature:${feature.id}:${phase}`,
    scopeType: 'feature_phase',
    scopeId: feature.id,
    phase,
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
  };
  ports.store.createAgentRun(run);
  return run;
}

export function taskDispatchForRun(run: TaskAgentRun): TaskRuntimeDispatch {
  if (run.sessionId) {
    return {
      mode: 'resume',
      agentRunId: run.id,
      sessionId: run.sessionId,
    };
  }

  return {
    mode: 'start',
    agentRunId: run.id,
  };
}

function runningRunPatch(
  run: Pick<AgentRun, 'runStatus' | 'restartCount'>,
  result: Pick<DispatchRunResult, 'sessionId'>,
): Pick<AgentRun, 'runStatus' | 'owner' | 'sessionId' | 'restartCount'> {
  return {
    runStatus: 'running',
    owner: 'system',
    sessionId: result.sessionId,
    restartCount:
      run.runStatus === 'retry_await' ? run.restartCount + 1 : run.restartCount,
  };
}

export function persistRunningTaskRun(
  ports: OrchestratorPorts,
  run: TaskAgentRun,
  result: Pick<DispatchRunResult, 'sessionId'>,
): void {
  ports.store.updateAgentRun(run.id, runningRunPatch(run, result));
}

export function persistRunningFeaturePhaseRun(
  ports: OrchestratorPorts,
  run: FeaturePhaseAgentRun,
  result: Pick<DispatchRunResult, 'sessionId'>,
): void {
  ports.store.updateAgentRun(run.id, runningRunPatch(run, result));
}

export function markTaskRunning(
  transitionTask: (
    taskId: Task['id'],
    patch: { status: 'running'; collabControl: 'branch_open' },
  ) => void,
  task: Task,
): void {
  if (task.status !== 'running' || task.collabControl !== 'branch_open') {
    transitionTask(task.id, {
      status: 'running',
      collabControl: 'branch_open',
    });
  }
}

export function markFeaturePhaseRunning(
  transitionFeature: (
    featureId: Feature['id'],
    patch: { status: 'in_progress' },
  ) => void,
  feature: Feature,
): void {
  if (feature.status !== 'in_progress') {
    transitionFeature(feature.id, {
      status: 'in_progress',
    });
  }
}

async function dispatchTaskRun(params: {
  task: Task;
  run: TaskAgentRun;
  payload: ReturnType<typeof buildTaskPayload>;
  ports: OrchestratorPorts;
}): Promise<DispatchRunResult> {
  const scope = {
    kind: 'task' as const,
    taskId: params.task.id,
    featureId: params.task.featureId,
  };
  const dispatch = taskDispatchForRun(params.run);
  const result = await params.ports.runtime.dispatchRun(scope, dispatch, {
    kind: 'task',
    task: params.task,
    payload: params.payload,
  });

  if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
    return await params.ports.runtime.dispatchRun(
      scope,
      {
        mode: 'start',
        agentRunId: params.run.id,
      },
      {
        kind: 'task',
        task: params.task,
        payload: params.payload,
      },
    );
  }

  return result;
}

export async function dispatchTaskUnit(params: {
  task: Task;
  graph: FeatureGraph;
  ports: OrchestratorPorts;
  markTaskRunning: (task: Task) => void;
}): Promise<void> {
  const run = ensureTaskRun(params.ports, params.task);

  const feature = params.graph.features.get(params.task.featureId);
  if (feature === undefined) {
    throw new Error(
      `dispatchTaskUnit: feature ${params.task.featureId} not found for task ${params.task.id}`,
    );
  }
  await params.ports.worktree.ensureFeatureWorktree(feature);
  await params.ports.worktree.ensureTaskWorktree(params.task, feature);

  const payload = buildTaskPayload(params.task, feature);
  const result = await dispatchTaskRun({
    task: params.task,
    run,
    payload,
    ports: params.ports,
  });

  params.markTaskRunning(params.task);
  persistRunningTaskRun(params.ports, run, result);
}

export async function dispatchFeaturePhaseUnit(params: {
  feature: Feature;
  phase: AgentRunPhase;
  ports: OrchestratorPorts;
  markFeaturePhaseRunning: (feature: Feature) => void;
  handleEvent: (event: SchedulerEvent) => Promise<void>;
}): Promise<boolean> {
  const run = ensureFeaturePhaseRun(
    params.ports,
    params.feature,
    params.phase,
  ) as FeaturePhaseAgentRun;
  if (isProposalPhase(params.phase) && run.runStatus === 'completed') {
    return false;
  }

  params.markFeaturePhaseRunning(params.feature);

  try {
    await params.ports.worktree.ensureFeatureWorktree(params.feature);

    if (params.phase === 'discuss') {
      const dispatch =
        run.sessionId === undefined
          ? { mode: 'start' as const, agentRunId: run.id }
          : {
              mode: 'resume' as const,
              agentRunId: run.id,
              sessionId: run.sessionId,
            };
      const scope = {
        kind: 'feature_phase' as const,
        featureId: params.feature.id,
        phase: params.phase,
      };
      let result = await params.ports.runtime.dispatchRun(scope, dispatch, {
        kind: 'feature_phase',
      });

      if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
        result = await params.ports.runtime.dispatchRun(
          scope,
          {
            mode: 'start',
            agentRunId: run.id,
          },
          {
            kind: 'feature_phase',
          },
        );
      }

      if (result.kind !== 'completed_inline') {
        throw new Error(
          `dispatchFeaturePhaseUnit: discuss expected completed_inline result, got '${result.kind}'`,
        );
      }
      if (
        result.output.kind !== 'text_phase' ||
        result.output.phase !== 'discuss'
      ) {
        throw new Error(
          `dispatchFeaturePhaseUnit: discuss expected text_phase/discuss output, got '${result.output.kind}'`,
        );
      }

      persistRunningFeaturePhaseRun(params.ports, run, result);
      await params.handleEvent({
        type: 'feature_phase_complete',
        featureId: params.feature.id,
        phase: params.phase,
        summary: result.output.result.summary,
      });
      return true;
    }

    params.ports.store.updateAgentRun(run.id, {
      runStatus: 'running',
      owner: 'system',
    });

    const runContext = {
      agentRunId: run.id,
      ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    };
    switch (params.phase) {
      case 'research': {
        const result = await params.ports.agents.researchFeature(
          params.feature,
          runContext,
        );
        await params.handleEvent({
          type: 'feature_phase_complete',
          featureId: params.feature.id,
          phase: params.phase,
          summary: result.summary,
        });
        return true;
      }
      case 'plan': {
        const result = await params.ports.agents.planFeature(
          params.feature,
          runContext,
        );
        params.ports.store.updateAgentRun(run.id, {
          runStatus: 'await_approval',
          owner: 'manual',
          payloadJson: JSON.stringify(result.proposal),
        });
        return true;
      }
      case 'ci_check': {
        const verification = await params.ports.verification.verifyFeature(
          params.feature,
        );
        await params.handleEvent({
          type: 'feature_phase_complete',
          featureId: params.feature.id,
          phase: params.phase,
          summary: verification.summary ?? '',
          verification,
        });
        return true;
      }
      case 'verify': {
        const verification = await params.ports.agents.verifyFeature(
          params.feature,
          runContext,
        );
        await params.handleEvent({
          type: 'feature_phase_complete',
          featureId: params.feature.id,
          phase: params.phase,
          summary: verification.summary ?? '',
          verification,
        });
        return true;
      }
      case 'summarize': {
        const result = await params.ports.agents.summarizeFeature(
          params.feature,
          runContext,
        );
        await params.handleEvent({
          type: 'feature_phase_complete',
          featureId: params.feature.id,
          phase: params.phase,
          summary: result.summary,
        });
        return true;
      }
      case 'replan': {
        const result = await params.ports.agents.replanFeature(
          params.feature,
          deriveReplanReason(params.ports, params.feature),
          runContext,
        );
        params.ports.store.updateAgentRun(run.id, {
          runStatus: 'await_approval',
          owner: 'manual',
          payloadJson: JSON.stringify(result.proposal),
        });
        return true;
      }
      case 'execute':
        return true;
    }
  } catch (error) {
    await params.handleEvent({
      type: 'feature_phase_error',
      featureId: params.feature.id,
      phase: params.phase,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export function deriveReplanReason(
  ports: Pick<OrchestratorPorts, 'store'>,
  feature: Feature,
): string {
  const events = ports.store.listEvents({ entityId: feature.id });
  const latestRerun = findLatestEvent(events, 'proposal_rerun_requested');
  const latestApplyFailed = findLatestEvent(events, 'proposal_apply_failed');
  const latestRejected = findLatestEvent(events, 'proposal_rejected');
  const latestVerify = findLatestPhaseCompletion(events, 'verify');
  const latestFeatureCi = findLatestPhaseCompletion(events, 'ci_check');

  const primary =
    readEventSummary(latestRerun) ??
    readEventSummary(latestApplyFailed) ??
    readEventSummary(latestRejected) ??
    readFailedVerificationSummary(latestVerify) ??
    readFailedVerificationSummary(latestFeatureCi);

  const issuesSummary = summarizeVerifyIssues(feature.verifyIssues);

  if (primary !== undefined && issuesSummary !== undefined) {
    return `${primary}\n\n${issuesSummary}`;
  }
  return primary ?? issuesSummary ?? 'Scheduler requested replanning.';
}

function summarizeVerifyIssues(
  issues: Feature['verifyIssues'],
): string | undefined {
  if (issues === undefined || issues.length === 0) {
    return undefined;
  }
  const actionable = issues.filter((issue) => issue.severity !== 'nit');
  if (actionable.length === 0) {
    return undefined;
  }
  const lines = actionable.map(
    (issue) => `- [${issue.source}] ${issue.description}`,
  );
  const header =
    actionable.length === 1
      ? 'Outstanding verify issue:'
      : `Outstanding verify issues (${actionable.length}):`;
  return [header, ...lines].join('\n');
}

function findLatestEvent(
  events: readonly EventRecord[],
  eventType: string,
): EventRecord | undefined {
  return [...events].reverse().find((event) => event.eventType === eventType);
}

function findLatestPhaseCompletion(
  events: readonly EventRecord[],
  phase: AgentRun['phase'],
): EventRecord | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === 'feature_phase_completed' &&
        event.payload?.phase === phase,
    );
}

function readEventSummary(event: EventRecord | undefined): string | undefined {
  if (event === undefined) {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload?.summary === 'string' && payload.summary.length > 0) {
    return payload.summary;
  }
  if (typeof payload?.error === 'string' && payload.error.length > 0) {
    return payload.error;
  }
  if (typeof payload?.comment === 'string' && payload.comment.length > 0) {
    return payload.comment;
  }
  const extra = payload?.extra;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    return undefined;
  }
  const summary = (extra as Record<string, unknown>).summary;
  return typeof summary === 'string' && summary.length > 0
    ? summary
    : undefined;
}

function readFailedVerificationSummary(
  event: EventRecord | undefined,
): string | undefined {
  if (event === undefined) {
    return undefined;
  }
  const extra = event.payload?.extra;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    return undefined;
  }
  const record = extra as Record<string, unknown>;
  if (record.ok === false || record.outcome === 'repair_needed') {
    return readEventSummary(event);
  }
  return undefined;
}

export async function dispatchReadyWork(params: {
  graph: FeatureGraph;
  ports: OrchestratorPorts;
  now: number;
  autoExecutionEnabled: boolean;
  readySince: Map<string, number>;
  handleEvent: (event: SchedulerEvent) => Promise<void>;
  markTaskRunning: (task: Task) => void;
  markFeaturePhaseRunning: (feature: Feature) => void;
}): Promise<void> {
  if (!params.autoExecutionEnabled) {
    syncReadySince(params.readySince, [], params.now);
    return;
  }

  const idleWorkers = params.ports.runtime.idleWorkerCount();
  if (idleWorkers <= 0) {
    syncReadySince(params.readySince, [], params.now);
    return;
  }

  const runs = createRunReader(params.ports);
  const ready = prioritizeReadyWork(
    params.graph,
    runs,
    computeGraphMetrics(buildCombinedGraph(params.graph)),
    params.now,
    params.readySince,
  );
  syncReadySince(params.readySince, ready, params.now);

  let dispatched = 0;
  for (const unit of ready) {
    if (dispatched >= idleWorkers) {
      break;
    }

    if (unit.kind === 'task') {
      await dispatchTaskUnit({
        task: unit.task,
        graph: params.graph,
        ports: params.ports,
        markTaskRunning: params.markTaskRunning,
      });
      dispatched++;
      continue;
    }

    if (
      await dispatchFeaturePhaseUnit({
        feature: unit.feature,
        phase: unit.phase,
        ports: params.ports,
        markFeaturePhaseRunning: params.markFeaturePhaseRunning,
        handleEvent: params.handleEvent,
      })
    ) {
      dispatched++;
    }
  }
}
