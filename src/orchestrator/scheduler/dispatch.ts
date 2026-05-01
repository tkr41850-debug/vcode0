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
  RoutingTier,
  Task,
  TaskAgentRun,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  isProposalPhase,
  serializeStoredProposalPayload,
} from '@orchestrator/proposals/index';
import { buildTaskPayload } from '@runtime/context/index';
import type {
  DispatchRunResult,
  FeaturePhaseRunPayload,
  PhaseOutput,
  RuntimeDispatch,
  TaskRunPayload,
  TaskRuntimeDispatch,
} from '@runtime/contracts';
import { ModelRouter, routingConfigOrDefault } from '@runtime/routing/index';

import type { SchedulerEvent } from './index.js';

export function createRunReader(ports: OrchestratorPorts): ExecutionRunReader {
  const runs = ports.store.listAgentRuns();
  const byTaskId = new Map<string, AgentRun>();
  const byFeaturePhase = new Map<string, AgentRun>();

  for (const run of runs) {
    switch (run.scopeType) {
      case 'task':
        byTaskId.set(run.scopeId, run);
        break;
      case 'feature_phase':
        byFeaturePhase.set(`${run.scopeId}:${run.phase}`, run);
        break;
      case 'project':
        // Project runs are not consumed by prioritizeReadyWork; phase-4-project-planner-agent
        // dispatches them through the coordinator, not the run reader.
        break;
      default: {
        const exhaustive: never = run;
        throw new Error(
          `createRunReader: unexpected scopeType: ${(exhaustive as AgentRun).scopeType}`,
        );
      }
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
  result: Pick<
    DispatchRunResult,
    'sessionId' | 'harnessKind' | 'workerPid' | 'workerBootEpoch'
  >,
): Pick<
  AgentRun,
  | 'runStatus'
  | 'owner'
  | 'sessionId'
  | 'harnessKind'
  | 'workerPid'
  | 'workerBootEpoch'
  | 'restartCount'
> {
  return {
    runStatus: 'running',
    owner: 'system',
    sessionId: result.sessionId,
    ...(result.harnessKind !== undefined
      ? { harnessKind: result.harnessKind }
      : {}),
    ...(result.workerPid !== undefined ? { workerPid: result.workerPid } : {}),
    ...(result.workerBootEpoch !== undefined
      ? { workerBootEpoch: result.workerBootEpoch }
      : {}),
    restartCount:
      run.runStatus === 'retry_await' ? run.restartCount + 1 : run.restartCount,
  };
}

function proposalAwaitingApprovalPatch(
  run: Pick<AgentRun, 'runStatus' | 'restartCount'>,
  result: Pick<
    DispatchRunResult,
    'sessionId' | 'harnessKind' | 'workerPid' | 'workerBootEpoch'
  >,
  payloadJson: string,
): Pick<
  AgentRun,
  | 'runStatus'
  | 'owner'
  | 'sessionId'
  | 'harnessKind'
  | 'workerPid'
  | 'workerBootEpoch'
  | 'payloadJson'
  | 'restartCount'
> {
  return {
    runStatus: 'await_approval',
    owner: 'manual',
    sessionId: result.sessionId,
    ...(result.harnessKind !== undefined
      ? { harnessKind: result.harnessKind }
      : {}),
    ...(result.workerPid !== undefined ? { workerPid: result.workerPid } : {}),
    ...(result.workerBootEpoch !== undefined
      ? { workerBootEpoch: result.workerBootEpoch }
      : {}),
    payloadJson,
    restartCount:
      run.runStatus === 'retry_await' ? run.restartCount + 1 : run.restartCount,
  };
}

export function persistRunningTaskRun(
  ports: OrchestratorPorts,
  run: TaskAgentRun,
  result: Pick<
    DispatchRunResult,
    'sessionId' | 'harnessKind' | 'workerPid' | 'workerBootEpoch'
  >,
): void {
  ports.store.updateAgentRun(run.id, runningRunPatch(run, result));
}

export function persistRunningFeaturePhaseRun(
  ports: OrchestratorPorts,
  run: FeaturePhaseAgentRun,
  result: Pick<
    DispatchRunResult,
    'sessionId' | 'harnessKind' | 'workerPid' | 'workerBootEpoch'
  >,
): void {
  ports.store.updateAgentRun(run.id, runningRunPatch(run, result));
}

export function persistAwaitingApprovalFeaturePhaseRun(
  ports: OrchestratorPorts,
  run: FeaturePhaseAgentRun,
  result: Pick<
    DispatchRunResult,
    'sessionId' | 'harnessKind' | 'workerPid' | 'workerBootEpoch'
  >,
  payloadJson: string,
): void {
  ports.store.updateAgentRun(
    run.id,
    proposalAwaitingApprovalPatch(run, result, payloadJson),
  );
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
  payload: TaskRunPayload;
  ports: OrchestratorPorts;
}): Promise<DispatchRunResult> {
  const scope = {
    kind: 'task' as const,
    taskId: params.task.id,
    featureId: params.task.featureId,
  };
  const dispatch = taskDispatchForRun(params.run);
  const result = await params.ports.runtime.dispatchRun(
    scope,
    dispatch,
    params.payload,
  );

  if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
    return await params.ports.runtime.dispatchRun(
      scope,
      {
        mode: 'start',
        agentRunId: params.run.id,
      },
      params.payload,
    );
  }

  return result;
}

function featurePhaseDispatchForRun(
  run: FeaturePhaseAgentRun,
): RuntimeDispatch {
  if (run.sessionId === undefined) {
    return {
      mode: 'start',
      agentRunId: run.id,
    };
  }

  return {
    mode: 'resume',
    agentRunId: run.id,
    sessionId: run.sessionId,
  };
}

const taskModelRouter = new ModelRouter();

function buildTaskRunPayload(
  ports: Pick<OrchestratorPorts, 'config'>,
  task: Task,
  feature: Feature | undefined,
): TaskRunPayload {
  const routing = taskModelRouter.routeModel(
    taskRoutingTier(),
    routingConfigOrDefault(ports.config),
  );

  return {
    kind: 'task',
    task,
    payload: buildTaskPayload(task, feature),
    model: routing.model,
    routingTier: routing.tier,
  };
}

function taskRoutingTier(): RoutingTier {
  return 'standard';
}

function featurePhasePayload(
  ports: Pick<OrchestratorPorts, 'store'>,
  feature: Feature,
  phase: AgentRunPhase,
): FeaturePhaseRunPayload {
  return {
    kind: 'feature_phase',
    ...(phase === 'replan'
      ? { replanReason: deriveReplanReason(ports, feature) }
      : {}),
  };
}

function isRuntimeDispatchedFeaturePhase(
  phase: AgentRunPhase,
): phase is
  | 'discuss'
  | 'research'
  | 'plan'
  | 'replan'
  | 'verify'
  | 'ci_check'
  | 'summarize' {
  return (
    phase === 'discuss' ||
    phase === 'research' ||
    phase === 'plan' ||
    phase === 'replan' ||
    phase === 'verify' ||
    phase === 'ci_check' ||
    phase === 'summarize'
  );
}

function featurePhaseRequiresFeatureWorktree(phase: AgentRunPhase): boolean {
  // discuss/research/plan/replan use proposal+inspection hosts and projectRoot,
  // not a feature worktree. execute, verify, ci_check, summarize do.
  return (
    phase === 'execute' ||
    phase === 'verify' ||
    phase === 'ci_check' ||
    phase === 'summarize'
  );
}

async function dispatchFeaturePhaseRun(params: {
  feature: Feature;
  phase:
    | 'discuss'
    | 'research'
    | 'plan'
    | 'replan'
    | 'verify'
    | 'ci_check'
    | 'summarize';
  run: FeaturePhaseAgentRun;
  ports: OrchestratorPorts;
}): Promise<DispatchRunResult> {
  const scope = {
    kind: 'feature_phase' as const,
    featureId: params.feature.id,
    phase: params.phase,
  };
  const dispatch = featurePhaseDispatchForRun(params.run);
  const payload = featurePhasePayload(
    params.ports,
    params.feature,
    params.phase,
  );
  const result = await params.ports.runtime.dispatchRun(
    scope,
    dispatch,
    payload,
  );

  if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
    return await params.ports.runtime.dispatchRun(
      scope,
      {
        mode: 'start',
        agentRunId: params.run.id,
      },
      payload,
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

  const payload = buildTaskRunPayload(params.ports, params.task, feature);
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
    if (featurePhaseRequiresFeatureWorktree(params.phase)) {
      await params.ports.worktree.ensureFeatureWorktree(params.feature);
    }

    if (params.phase === 'execute') {
      return true;
    }
    if (!isRuntimeDispatchedFeaturePhase(params.phase)) {
      throw new Error(
        `dispatchFeaturePhaseUnit: phase '${params.phase}' is not runtime-dispatched`,
      );
    }

    // Persist runStatus='running' BEFORE awaiting dispatchFeaturePhaseRun so
    // operator-driven surfaces (TUI sendPlannerChatInput, respondTo*, attach)
    // can find the run live during its long-running outcome promise. The
    // post-dispatch persist (awaiting_approval / completed_inline) replaces
    // this in-flight marker.
    if (run.runStatus !== 'running') {
      params.ports.store.updateAgentRun(run.id, {
        runStatus: 'running',
        owner: 'system',
        sessionId: run.sessionId ?? run.id,
        restartCount:
          run.runStatus === 'retry_await'
            ? run.restartCount + 1
            : run.restartCount,
      });
    }

    const result = await dispatchFeaturePhaseRun({
      feature: params.feature,
      phase: params.phase,
      run,
      ports: params.ports,
    });

    await synthesizeFeaturePhaseDispatchResult({
      feature: params.feature,
      phase: params.phase,
      run,
      result,
      ports: params.ports,
      handleEvent: params.handleEvent,
    });
    return true;
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

async function synthesizeFeaturePhaseDispatchResult(params: {
  feature: Feature;
  phase:
    | 'discuss'
    | 'research'
    | 'plan'
    | 'replan'
    | 'verify'
    | 'ci_check'
    | 'summarize';
  run: FeaturePhaseAgentRun;
  result: DispatchRunResult;
  ports: OrchestratorPorts;
  handleEvent: (event: SchedulerEvent) => Promise<void>;
}): Promise<void> {
  if (isProposalPhase(params.phase)) {
    if (params.result.kind !== 'awaiting_approval') {
      throw new Error(
        `dispatchFeaturePhaseUnit: ${params.phase} expected awaiting_approval result, got '${params.result.kind}'`,
      );
    }
    if (
      params.result.output.kind !== 'proposal' ||
      params.result.output.phase !== params.phase
    ) {
      throw new Error(
        `dispatchFeaturePhaseUnit: ${params.phase} expected proposal/${params.phase} output, got '${params.result.output.kind}'`,
      );
    }

    persistAwaitingApprovalFeaturePhaseRun(
      params.ports,
      params.run,
      params.result,
      serializeStoredProposalPayload({
        proposal: params.result.output.result.proposal,
        recovery: {
          phaseSummary: params.result.output.result.summary,
          phaseDetails: params.result.output.result.details,
        },
      }),
    );
    params.ports.store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: params.feature.id,
      timestamp: Date.now(),
      payload: {
        phase: params.phase,
        summary: params.result.output.result.summary,
        sessionId: params.result.sessionId,
        extra: params.result.output.result.details,
      },
    });
    return;
  }

  if (params.result.kind !== 'completed_inline') {
    throw new Error(
      `dispatchFeaturePhaseUnit: ${params.phase} expected completed_inline result, got '${params.result.kind}'`,
    );
  }

  const completion = featurePhaseCompletionEvent(
    params.feature.id,
    params.phase,
    params.result.sessionId,
    params.result.output,
  );
  persistRunningFeaturePhaseRun(params.ports, params.run, params.result);
  await params.handleEvent(completion);
}

function featurePhaseCompletionEvent(
  featureId: Feature['id'],
  phase: Exclude<AgentRunPhase, 'execute' | 'plan' | 'replan'>,
  sessionId: string,
  output: PhaseOutput,
): SchedulerEvent {
  if (phase === 'verify') {
    if (output.kind !== 'verification') {
      throw new Error(
        `dispatchFeaturePhaseUnit: verify expected verification output, got '${output.kind}'`,
      );
    }
    return {
      type: 'feature_phase_complete',
      featureId,
      phase,
      summary: output.verification.summary ?? '',
      sessionId,
      extra: output.verification,
      verification: output.verification,
    };
  }

  if (phase === 'ci_check') {
    if (output.kind !== 'ci_check') {
      throw new Error(
        `dispatchFeaturePhaseUnit: ci_check expected ci_check output, got '${output.kind}'`,
      );
    }
    return {
      type: 'feature_phase_complete',
      featureId,
      phase,
      summary: output.verification.summary ?? '',
      sessionId,
      extra: output.verification,
      verification: output.verification,
    };
  }

  if (output.kind !== 'text_phase' || output.phase !== phase) {
    throw new Error(
      `dispatchFeaturePhaseUnit: ${phase} expected text_phase/${phase} output, got '${output.kind}'`,
    );
  }

  return {
    type: 'feature_phase_complete',
    featureId,
    phase,
    summary: output.result.summary,
    sessionId,
    ...(mergeSummaryExtra(output.result.summary, output.result.extra) !==
    undefined
      ? { extra: mergeSummaryExtra(output.result.summary, output.result.extra) }
      : {}),
  };
}

function mergeSummaryExtra(summary: string, extra: unknown): unknown {
  if (extra === undefined) {
    return undefined;
  }
  if (typeof extra === 'object' && extra !== null && !Array.isArray(extra)) {
    return {
      summary,
      ...(extra as Record<string, unknown>),
    };
  }
  return extra;
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
  if (record.ok === false || record.outcome === 'replan_needed') {
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

    const featureId =
      unit.kind === 'task' ? unit.task.featureId : unit.feature.id;
    const depCheck = hasUnmergedFeatureDep(params.graph, featureId);
    if (depCheck.unmerged) {
      const unitId = unit.kind === 'task' ? unit.task.id : unit.feature.id;
      console.warn(
        `[scheduler] dispatch guard: ${unit.kind} ${unitId} for feature ${featureId} has unmerged dep ${depCheck.depId}; skipping`,
      );
      continue;
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

export function hasUnmergedFeatureDep(
  graph: FeatureGraph,
  featureId: Feature['id'],
): { unmerged: true; depId: Feature['id'] } | { unmerged: false } {
  const feature = graph.features.get(featureId);
  if (!feature) return { unmerged: false };
  for (const depId of feature.dependsOn) {
    const dep = graph.features.get(depId);
    if (!dep) continue;
    if (dep.workControl !== 'work_complete' || dep.collabControl !== 'merged') {
      return { unmerged: true, depId };
    }
  }
  return { unmerged: false };
}
