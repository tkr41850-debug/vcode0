import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { persistPhaseOutputToFeature } from '@agents';
import type { FeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type {
  AgentRunPhase,
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  ProposalPhaseDetails,
  RoutingTier,
  Task,
  TaskAgentRun,
} from '@core/types/index';
import { createEmptyVerificationChecksWarning } from '@core/warnings/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  isProposalPhase,
  parseStoredProposalPayload,
  serializeStoredProposalPayload,
} from '@orchestrator/proposals/index';
import {
  deriveReplanReason,
  taskDispatchForRun,
} from '@orchestrator/scheduler/dispatch';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
import { buildTaskPayload } from '@runtime/context/index';
import type {
  DispatchRunResult,
  FeaturePhaseRunPayload,
  PhaseOutput,
  RuntimeDispatch,
  TaskRunPayload,
} from '@runtime/contracts';
import { CURRENT_ORCHESTRATOR_BOOT_EPOCH } from '@runtime/harness/index';
import { ModelRouter, routingConfigOrDefault } from '@runtime/routing/index';

type ProcEnvironmentReader = (
  pid: number,
) => Promise<Record<string, string> | null>;

const taskModelRouter = new ModelRouter();

function buildRecoveredTaskRunPayload(
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

export class RecoveryService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
    private readonly projectRoot = process.cwd(),
    private readonly readProcEnvironment: ProcEnvironmentReader = readProcEnvironmentMarkers,
  ) {}

  async recoverOrphanedRuns(): Promise<void> {
    const runs = this.ports.store.listAgentRuns();

    for (const run of runs) {
      if (run.runStatus === 'retry_await') {
        continue;
      }

      if (run.scopeType === 'task') {
        await this.recoverTaskRun(run);
        continue;
      }

      await this.recoverFeaturePhaseRun(run);
    }
  }

  private async recoverTaskRun(run: TaskAgentRun): Promise<void> {
    const task = this.graph.tasks.get(run.scopeId);
    if (task === undefined) {
      return;
    }

    const shouldCleanStaleWorker = shouldResumeTaskRun(run);
    if (shouldCleanStaleWorker) {
      await this.killStaleWorkerIfNeeded(run);
    }

    if (task.status === 'cancelled') {
      if (run.runStatus !== 'completed' && run.runStatus !== 'cancelled') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'cancelled',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
      return;
    }

    if (task.collabControl === 'suspended') {
      if (run.runStatus === 'running') {
        this.resetTaskRunToReady(run, { preserveSession: true });
      }
      if (
        run.runStatus === 'await_response' ||
        run.runStatus === 'await_approval'
      ) {
        this.resetTaskRunToReady(run, {
          clearPayload: true,
          preserveSession: true,
        });
      }
      return;
    }

    if (shouldResumeTaskRun(run)) {
      const resumed = await this.resumeTaskRun(task, run);
      if (resumed) {
        return;
      }
    }

    if (
      run.runStatus === 'await_response' ||
      run.runStatus === 'await_approval'
    ) {
      this.resetTaskRunToReady(run, { clearPayload: true });
      return;
    }

    if (run.runStatus !== 'running') {
      return;
    }

    this.resetTaskRunToReady(run);
  }

  private resetTaskRunToReady(
    run: TaskAgentRun,
    options?: { clearPayload?: boolean; preserveSession?: boolean },
  ): void {
    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: options?.preserveSession ? run.sessionId : undefined,
      ...(options?.clearPayload ? { payloadJson: undefined } : {}),
      restartCount: run.restartCount + 1,
    });
  }

  private async resumeTaskRun(task: Task, run: TaskAgentRun): Promise<boolean> {
    if (run.sessionId === undefined) {
      return false;
    }

    await this.rebaseTaskWorktree(task);
    const dispatch = taskDispatchForRun(run);
    if (dispatch.mode !== 'resume') {
      return false;
    }

    const feature = this.graph.features.get(task.featureId);
    const payload = buildRecoveredTaskRunPayload(this.ports, task, feature);
    const result = await this.ports.runtime.dispatchRun(
      {
        kind: 'task',
        taskId: task.id,
        featureId: task.featureId,
      },
      dispatch,
      payload,
    );
    if (result.kind === 'not_resumable') {
      return false;
    }

    this.ports.store.updateAgentRun(run.id, {
      sessionId: result.sessionId,
      ...(result.harnessKind !== undefined
        ? { harnessKind: result.harnessKind }
        : {}),
      ...(result.workerPid !== undefined
        ? { workerPid: result.workerPid }
        : {}),
      ...(result.workerBootEpoch !== undefined
        ? { workerBootEpoch: result.workerBootEpoch }
        : {}),
      restartCount: run.restartCount + 1,
    });
    return true;
  }

  private async recoverFeaturePhaseRun(
    run: FeaturePhaseAgentRun,
  ): Promise<void> {
    const feature = this.graph.features.get(run.scopeId);
    if (feature === undefined) {
      return;
    }

    // Operator-attach orphan reclaim. Feature-phase runs are in-process; if
    // a run is persisted as `manual/operator` from a previous boot, the
    // attached agent + session-resolver are gone with the process. Reclaim
    // BEFORE the existing branches so `running`/`await_response` paths
    // don't intercept and try to redispatch with stale state. Plan/replan
    // only — non-proposal phases don't carry attention='operator' today.
    if (
      (run.phase === 'plan' || run.phase === 'replan') &&
      run.attention === 'operator' &&
      run.owner === 'manual'
    ) {
      const previousRunStatus = run.runStatus;
      const sessionMessages =
        run.sessionId !== undefined
          ? await this.ports.sessionStore.load(run.sessionId)
          : null;
      const resumable = sessionMessages !== null;
      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'ready',
        owner: 'system',
        attention: 'none',
        payloadJson: undefined,
        ...(resumable ? {} : { sessionId: undefined }),
      });
      this.ports.store.appendEvent({
        eventType: 'feature_phase_orphaned_reclaim',
        entityId: feature.id,
        timestamp: Date.now(),
        payload: {
          phase: run.phase,
          previousRunStatus,
          resumable,
        },
      });
      return;
    }

    if (run.runStatus === 'running') {
      await this.killStaleWorkerIfNeeded(run);

      if (feature.collabControl === 'cancelled') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'cancelled',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        return;
      }

      const result = await this.dispatchFeaturePhaseRun(feature, run);
      if (result.kind === 'not_resumable') {
        return;
      }

      this.storeRecoveredFeaturePhaseDispatch(run, result);
      this.applyRecoveredFeaturePhaseResult(feature, run, result);
      return;
    }

    if (feature.collabControl === 'cancelled') {
      if (run.runStatus !== 'completed' && run.runStatus !== 'cancelled') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'cancelled',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
      return;
    }

    const completionEvent = this.findFeaturePhaseCompletionEvent(
      feature.id,
      run.phase,
      run.sessionId,
    );
    if (run.phase === 'plan' || run.phase === 'replan') {
      if (run.runStatus === 'await_response') {
        // Pending request_help waits live in the in-memory ProposalPhaseSession
        // and do not survive a restart: the toolCallId resolver is gone, so
        // /reply has nothing to answer. Reset the run to 'ready' so the
        // scheduler re-dispatches; the planner resumes from its persisted
        // session transcript and may re-issue request_help, this time with a
        // fresh toolCallId that the operator can answer.
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'ready',
          owner: 'system',
          payloadJson: undefined,
        });
        return;
      }
      if (run.runStatus === 'await_approval' && completionEvent === undefined) {
        this.backfillStoredProposalCompletion(run);
      }
      if (run.runStatus === 'completed') {
        this.replayStoredProposalDecision(
          feature.id,
          run.phase,
          run.payloadJson,
        );
      }
      return;
    }
    if (this.shouldReplayStoredFeaturePhaseSideEffects(feature, run)) {
      if (completionEvent !== undefined) {
        this.replayStoredFeaturePhaseCompletion(
          feature,
          run.phase,
          completionEvent,
        );
        return;
      }

      const result = await this.dispatchFeaturePhaseRun(feature, run);
      if (result.kind === 'not_resumable') {
        return;
      }

      this.storeRecoveredFeaturePhaseDispatch(run, result);
      this.applyRecoveredFeaturePhaseResult(feature, run, result);
      return;
    }

    return;
  }

  private async dispatchFeaturePhaseRun(
    feature: Feature,
    run: FeaturePhaseAgentRun,
  ): Promise<DispatchRunResult> {
    const scope = {
      kind: 'feature_phase' as const,
      featureId: feature.id,
      phase: run.phase,
    };
    const payload = this.featurePhasePayload(feature, run.phase);
    const dispatch = featurePhaseDispatchForRun(run);
    const result = await this.ports.runtime.dispatchRun(
      scope,
      dispatch,
      payload,
    );
    if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
      return await this.ports.runtime.dispatchRun(
        scope,
        {
          mode: 'start',
          agentRunId: run.id,
        },
        payload,
      );
    }
    return result;
  }

  private featurePhasePayload(
    feature: Feature,
    phase: AgentRunPhase,
  ): FeaturePhaseRunPayload {
    return {
      kind: 'feature_phase',
      ...(phase === 'replan'
        ? { replanReason: deriveReplanReason(this.ports, feature) }
        : {}),
    };
  }

  private applyRecoveredFeaturePhaseResult(
    feature: Feature,
    run: FeaturePhaseAgentRun,
    result: Exclude<DispatchRunResult, { kind: 'not_resumable' }>,
  ): void {
    if (result.kind === 'awaiting_approval') {
      if (
        result.output.kind !== 'proposal' ||
        result.output.phase !== run.phase
      ) {
        throw new Error(
          `recoverOrphanedRuns: ${run.phase} expected proposal/${run.phase} output, got '${result.output.kind}'`,
        );
      }
      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'await_approval',
        owner: 'manual',
        ...(result.harnessKind !== undefined
          ? { harnessKind: result.harnessKind }
          : {}),
        ...(result.workerPid !== undefined
          ? { workerPid: result.workerPid }
          : {}),
        ...(result.workerBootEpoch !== undefined
          ? { workerBootEpoch: result.workerBootEpoch }
          : {}),
        payloadJson: serializeStoredProposalPayload({
          proposal: result.output.result.proposal,
          recovery: {
            phaseSummary: result.output.result.summary,
            phaseDetails: result.output.result.details,
          },
        }),
      });
      this.recordRecoveredFeaturePhaseCompletion(
        feature.id,
        run.phase,
        result.output.result.summary,
        result.output.result.details,
        result.sessionId,
      );
      return;
    }

    if (result.kind !== 'completed_inline') {
      throw new Error(
        `recoverOrphanedRuns: ${run.phase} expected completed_inline or awaiting_approval result, got '${result.kind}'`,
      );
    }

    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'completed',
      owner: 'system',
    });
    this.completeRecoveredFeaturePhase(
      feature,
      run.phase,
      result.output,
      result.sessionId,
    );
  }

  private completeRecoveredFeaturePhase(
    feature: Feature,
    phase: AgentRunPhase,
    output: PhaseOutput,
    sessionId?: string,
  ): void {
    const summaries = new SummaryCoordinator(
      this.graph,
      this.ports.config.tokenProfile,
    );
    const features = new FeatureLifecycleCoordinator(this.graph);

    if (phase === 'summarize') {
      if (output.kind !== 'text_phase' || output.phase !== 'summarize') {
        throw new Error(
          `recoverOrphanedRuns: summarize expected text_phase/summarize output, got '${output.kind}'`,
        );
      }
      this.recordRecoveredFeaturePhaseCompletion(
        feature.id,
        phase,
        output.result.summary,
        mergeSummaryExtra(output.result.summary, output.result.extra),
        sessionId,
      );
      summaries.completeSummary(feature.id, output.result.summary);
      return;
    }

    if (phase === 'ci_check') {
      if (output.kind !== 'ci_check') {
        throw new Error(
          `recoverOrphanedRuns: ci_check expected ci_check output, got '${output.kind}'`,
        );
      }
      this.recordRecoveredFeaturePhaseCompletion(
        feature.id,
        phase,
        output.verification.summary ?? '',
        output.verification,
        sessionId,
      );
      this.emitRecoveredEmptyVerificationChecksWarning(feature.id, 'feature');
      features.completePhase(feature.id, phase, output.verification);
      return;
    }

    if (phase === 'verify') {
      if (output.kind !== 'verification') {
        throw new Error(
          `recoverOrphanedRuns: verify expected verification output, got '${output.kind}'`,
        );
      }
      this.recordRecoveredFeaturePhaseCompletion(
        feature.id,
        phase,
        output.verification.summary ?? '',
        output.verification,
        sessionId,
      );
      features.completePhase(feature.id, phase, output.verification);
      return;
    }

    if (phase === 'discuss' || phase === 'research') {
      if (output.kind !== 'text_phase' || output.phase !== phase) {
        throw new Error(
          `recoverOrphanedRuns: ${phase} expected text_phase/${phase} output, got '${output.kind}'`,
        );
      }
      this.recordRecoveredFeaturePhaseCompletion(
        feature.id,
        phase,
        output.result.summary,
        mergeSummaryExtra(output.result.summary, output.result.extra),
        sessionId,
      );
      features.completePhase(feature.id, phase);
      return;
    }

    throw new Error(`recoverOrphanedRuns: phase '${phase}' is not recoverable`);
  }

  private storeRecoveredFeaturePhaseDispatch(
    run: FeaturePhaseAgentRun,
    result: Exclude<DispatchRunResult, { kind: 'not_resumable' }>,
  ): void {
    this.ports.store.updateAgentRun(run.id, {
      sessionId: result.sessionId,
      ...(result.harnessKind !== undefined
        ? { harnessKind: result.harnessKind }
        : {}),
      ...(result.workerPid !== undefined
        ? { workerPid: result.workerPid }
        : {}),
      ...(result.workerBootEpoch !== undefined
        ? { workerBootEpoch: result.workerBootEpoch }
        : {}),
      restartCount: run.restartCount + 1,
    });
  }

  private recordRecoveredFeaturePhaseCompletion(
    featureId: Feature['id'],
    phase: AgentRunPhase,
    summary: string,
    extra?: unknown,
    sessionId?: string,
  ): void {
    if (!this.hasFeaturePhaseCompletionEvent(featureId, phase, sessionId)) {
      this.ports.store.appendEvent({
        eventType: 'feature_phase_completed',
        entityId: featureId,
        timestamp: Date.now(),
        payload: {
          phase,
          summary,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(extra !== undefined ? { extra } : {}),
        },
      });
    }
    if (extra !== undefined) {
      persistPhaseOutputToFeature(this.graph, featureId, phase, extra);
    }
  }

  private backfillStoredProposalCompletion(run: FeaturePhaseAgentRun): void {
    if (!isProposalPhase(run.phase)) {
      return;
    }
    const stored = readStoredProposalRecovery(run.payloadJson, run.phase);
    if (
      stored?.phaseSummary === undefined ||
      stored.phaseDetails === undefined
    ) {
      return;
    }

    this.recordRecoveredFeaturePhaseCompletion(
      run.scopeId,
      run.phase,
      stored.phaseSummary,
      stored.phaseDetails,
      run.sessionId,
    );
  }

  private replayStoredProposalDecision(
    featureId: Feature['id'],
    phase: Extract<AgentRunPhase, 'plan' | 'replan'>,
    payloadJson?: string,
  ): void {
    const stored = readStoredProposalRecovery(payloadJson, phase);
    const decision = stored?.decision;
    if (decision === undefined) {
      return;
    }

    if (decision.kind === 'approved') {
      const hasAppliedEvent = this.ports.store
        .listEvents({ entityId: featureId })
        .some(
          (event) =>
            event.eventType === 'proposal_applied' &&
            event.payload?.phase === phase,
        );
      if (!hasAppliedEvent) {
        this.ports.store.appendEvent({
          eventType: 'proposal_applied',
          entityId: featureId,
          timestamp: Date.now(),
          payload: {
            phase,
            summary: decision.summary,
            ...decision.extra,
          },
        });
      }
      if (decision.cancelled === true) {
        const hasCancelledEvent = this.ports.store
          .listEvents({ entityId: featureId })
          .some(
            (event) =>
              event.eventType === 'feature_cancelled_empty_proposal' &&
              event.payload?.phase === phase,
          );
        if (!hasCancelledEvent) {
          this.ports.store.appendEvent({
            eventType: 'feature_cancelled_empty_proposal',
            entityId: featureId,
            timestamp: Date.now(),
            payload: {
              phase,
              reason: decision.cancelReason ?? 'empty_proposal',
            },
          });
        }
      }
      return;
    }

    if (decision.kind === 'rejected') {
      const hasRejectedEvent = this.ports.store
        .listEvents({ entityId: featureId })
        .some(
          (event) =>
            event.eventType === 'proposal_rejected' &&
            event.payload?.phase === phase,
        );
      if (!hasRejectedEvent) {
        this.ports.store.appendEvent({
          eventType: 'proposal_rejected',
          entityId: featureId,
          timestamp: Date.now(),
          payload: {
            phase,
            ...(decision.comment !== undefined
              ? { comment: decision.comment }
              : {}),
          },
        });
      }
      return;
    }

    const hasFailedEvent = this.ports.store
      .listEvents({ entityId: featureId })
      .some(
        (event) =>
          event.eventType === 'proposal_apply_failed' &&
          event.payload?.phase === phase,
      );
    if (!hasFailedEvent) {
      this.ports.store.appendEvent({
        eventType: 'proposal_apply_failed',
        entityId: featureId,
        timestamp: Date.now(),
        payload: {
          phase,
          error: decision.error,
        },
      });
    }
  }

  private hasFeaturePhaseCompletionEvent(
    featureId: Feature['id'],
    phase: AgentRunPhase,
    sessionId?: string,
  ): boolean {
    return (
      this.findFeaturePhaseCompletionEvent(featureId, phase, sessionId) !==
      undefined
    );
  }

  private findFeaturePhaseCompletionEvent(
    featureId: Feature['id'],
    phase: AgentRunPhase,
    sessionId?: string,
  ): EventRecord | undefined {
    return this.listFeaturePhaseCompletionEvents(featureId, phase).find(
      (event) =>
        sessionId === undefined ? true : event.payload?.sessionId === sessionId,
    );
  }

  private listFeaturePhaseCompletionEvents(
    featureId: Feature['id'],
    phase: AgentRunPhase,
  ): EventRecord[] {
    return this.ports.store
      .listEvents({ eventType: 'feature_phase_completed', entityId: featureId })
      .filter((event) => event.payload?.phase === phase);
  }

  private shouldReplayStoredFeaturePhaseSideEffects(
    feature: Feature,
    run: FeaturePhaseAgentRun,
  ): boolean {
    if (run.runStatus !== 'completed') {
      return false;
    }
    if (run.phase === 'plan' || run.phase === 'replan') {
      return false;
    }

    if (run.phase === 'discuss') {
      return feature.workControl === 'discussing';
    }
    if (run.phase === 'research') {
      return feature.workControl === 'researching';
    }
    if (run.phase === 'ci_check') {
      return feature.workControl === 'ci_check';
    }
    if (run.phase === 'verify') {
      return feature.workControl === 'verifying';
    }
    if (run.phase === 'summarize') {
      return feature.workControl === 'summarizing';
    }

    return false;
  }

  private replayStoredFeaturePhaseCompletion(
    feature: Feature,
    phase: AgentRunPhase,
    event: EventRecord,
  ): void {
    const extra = event.payload?.extra;
    const features = new FeatureLifecycleCoordinator(this.graph);
    const summaries = new SummaryCoordinator(
      this.graph,
      this.ports.config.tokenProfile,
    );

    if (extra !== undefined) {
      persistPhaseOutputToFeature(this.graph, feature.id, phase, extra);
    }

    if (phase === 'summarize') {
      const summary = event.payload?.summary;
      if (typeof summary !== 'string') {
        return;
      }
      summaries.completeSummary(feature.id, summary);
      return;
    }

    if (phase === 'ci_check') {
      this.emitRecoveredEmptyVerificationChecksWarning(feature.id, 'feature');
      if (isVerificationSummary(extra)) {
        features.completePhase(feature.id, phase, extra);
      }
      return;
    }

    if (phase === 'verify') {
      if (isVerificationSummary(extra)) {
        features.completePhase(feature.id, phase, extra);
      }
      return;
    }

    if (phase === 'discuss' || phase === 'research') {
      features.completePhase(feature.id, phase);
    }
  }

  private emitRecoveredEmptyVerificationChecksWarning(
    featureId: Feature['id'],
    layer: 'feature' | 'task',
  ): void {
    const checks =
      layer === 'feature'
        ? (this.ports.config.verification?.feature?.checks ?? [])
        : (this.ports.config.verification?.task?.checks ?? []);
    if (checks.length > 0) {
      return;
    }

    const alreadyLogged = this.ports.store
      .listEvents({ eventType: 'warning_emitted', entityId: featureId })
      .some((event) => {
        const extra = event.payload?.extra;
        return (
          event.payload?.category === 'empty_verification_checks' &&
          typeof extra === 'object' &&
          extra !== null &&
          'layer' in extra &&
          extra.layer === layer
        );
      });
    if (alreadyLogged) {
      return;
    }

    const warning = createEmptyVerificationChecksWarning(featureId, layer);
    this.ports.store.appendEvent({
      eventType: 'warning_emitted',
      entityId: featureId,
      timestamp: warning.occurredAt,
      payload: {
        category: warning.category,
        message: warning.message,
        ...(warning.payload !== undefined ? { extra: warning.payload } : {}),
      },
    });
  }

  private async rebaseTaskWorktree(task: Task): Promise<void> {
    const feature = this.graph.features.get(task.featureId);
    if (feature === undefined) {
      return;
    }

    const taskDir = path.resolve(
      this.projectRoot,
      worktreePath(resolveTaskWorktreeBranch(task)),
    );

    try {
      await fs.stat(taskDir);
    } catch {
      return;
    }

    const rebaseMarker = path.join(taskDir, 'RECOVERY_REBASE');
    await fs.writeFile(rebaseMarker, feature.featureBranch, 'utf-8');
  }

  private async killStaleWorkerIfNeeded(
    run: Pick<
      TaskAgentRun | FeaturePhaseAgentRun,
      'id' | 'harnessKind' | 'workerPid' | 'workerBootEpoch'
    >,
  ): Promise<void> {
    if (run.harnessKind !== undefined && run.harnessKind !== 'pi-sdk') {
      return;
    }

    if (
      run.workerPid === undefined ||
      run.workerBootEpoch === undefined ||
      run.workerBootEpoch === CURRENT_ORCHESTRATOR_BOOT_EPOCH
    ) {
      return;
    }

    const markers = await this.readProcEnvironment(run.workerPid);
    if (
      markers === null ||
      markers.GVC0_AGENT_RUN_ID !== run.id ||
      markers.GVC0_PROJECT_ROOT !== this.projectRoot
    ) {
      return;
    }

    try {
      process.kill(run.workerPid, 'SIGKILL');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
  }
}

async function readProcEnvironmentMarkers(
  pid: number,
): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`);
    return parseProcEnvironment(raw.toString('utf-8'));
  } catch {
    return null;
  }
}

function parseProcEnvironment(
  rawEnvironment: string,
): Record<string, string> | null {
  const environment: Record<string, string> = {};

  for (const entry of rawEnvironment.split('\0')) {
    if (entry.length === 0) {
      continue;
    }

    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      return null;
    }

    environment[entry.slice(0, separatorIndex)] = entry.slice(
      separatorIndex + 1,
    );
  }

  return environment;
}

function shouldResumeTaskRun(run: TaskAgentRun): boolean {
  return (
    run.runStatus === 'running' ||
    run.runStatus === 'await_response' ||
    run.runStatus === 'await_approval'
  );
}

function readStoredProposalRecovery(
  payloadJson: string | undefined,
  phase: 'plan' | 'replan',
):
  | {
      proposalJson: string;
      phaseSummary?: string;
      phaseDetails?: ProposalPhaseDetails;
      decision?:
        | {
            kind: 'approved';
            summary: string;
            extra: Record<string, unknown>;
            cancelled?: boolean;
            cancelReason?: 'empty_proposal';
          }
        | {
            kind: 'rejected';
            comment?: string;
          }
        | {
            kind: 'apply_failed';
            error: string;
          };
    }
  | undefined {
  if (payloadJson === undefined) {
    return undefined;
  }

  const stored = parseStoredProposalPayload(payloadJson, phase);
  return {
    proposalJson: serializeStoredProposalPayload({
      proposal: stored.proposal,
      ...(stored.recovery !== undefined ? { recovery: stored.recovery } : {}),
    }),
    ...(stored.recovery?.phaseSummary !== undefined
      ? { phaseSummary: stored.recovery.phaseSummary }
      : {}),
    ...(stored.recovery?.phaseDetails !== undefined
      ? { phaseDetails: stored.recovery.phaseDetails }
      : {}),
    ...(stored.recovery?.decision !== undefined
      ? { decision: stored.recovery.decision }
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

function isVerificationSummary(
  extra: unknown,
): extra is NonNullable<
  PhaseOutput extends { verification: infer T } ? T : never
> {
  return typeof extra === 'object' && extra !== null && 'ok' in extra;
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
