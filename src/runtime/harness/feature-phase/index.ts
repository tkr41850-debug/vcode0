import type { PlannerAgent } from '@agents/planner';
import type { ProposalPhaseResult } from '@agents/proposal';
import type { ReplannerAgent } from '@agents/replanner';
import type { LiveProposalPhaseSession } from '@agents/runtime';
import type { FeatureGraph } from '@core/graph/index';
import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  HarnessKind,
  VerificationSummary,
} from '@core/types/index';
import type {
  FeaturePhaseRunPayload,
  OrchestratorToWorkerMessage,
  PhaseOutput,
  RunScope,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { SessionExitInfo, SessionHandle } from '@runtime/harness/index';
import type { SessionStore } from '@runtime/sessions/index';

export type FeaturePhaseScope = Extract<RunScope, { kind: 'feature_phase' }>;

export type FeaturePhaseDispatchOutcome =
  | {
      kind: 'completed_inline';
      output: PhaseOutput;
    }
  | {
      kind: 'awaiting_approval';
      output: PhaseOutput;
    };

export interface FeaturePhaseSessionHandle extends SessionHandle {
  awaitOutcome(this: void): Promise<FeaturePhaseDispatchOutcome>;
  /**
   * For plan/replan handles backed by a {@link LiveProposalPhaseSession},
   * exposes the underlying session so the orchestrator can introspect /
   * resolve pending help requests. Undefined for synthetic handles built
   * around legacy planFeature/replanFeature wrappers and for non-proposal
   * phases (discuss/research/verify/ci_check/summarize).
   */
  proposalSession?: LiveProposalPhaseSession;
}

export type ResumeFeaturePhaseResult =
  | {
      kind: 'resumed';
      handle: FeaturePhaseSessionHandle;
    }
  | {
      kind: 'not_resumable';
      sessionId: string;
      reason: 'session_not_found' | 'path_mismatch' | 'unsupported_by_harness';
    };

export interface FeaturePhaseBackend {
  start(
    scope: FeaturePhaseScope,
    payload: FeaturePhaseRunPayload,
    agentRunId: string,
  ): Promise<FeaturePhaseSessionHandle>;
  resume(
    scope: FeaturePhaseScope,
    run: { agentRunId: string; sessionId: string },
    payload: FeaturePhaseRunPayload,
  ): Promise<ResumeFeaturePhaseResult>;
}

export interface ProposalPhaseAgent {
  startPlanFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): LiveProposalPhaseSession;
  startReplanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): LiveProposalPhaseSession;
}

export class DiscussFeaturePhaseBackend implements FeaturePhaseBackend {
  constructor(
    private readonly graph: Pick<FeatureGraph, 'features'>,
    private readonly agent: Pick<
      PlannerAgent,
      | 'discussFeature'
      | 'researchFeature'
      | 'planFeature'
      | 'verifyFeature'
      | 'summarizeFeature'
    > &
      Pick<ReplannerAgent, 'replanFeature'> &
      Partial<ProposalPhaseAgent>,
    private readonly verification: Pick<
      { verifyFeature(feature: Feature): Promise<VerificationSummary> },
      'verifyFeature'
    >,
    private readonly sessionStore: SessionStore,
  ) {}

  start(
    scope: FeaturePhaseScope,
    payload: FeaturePhaseRunPayload,
    agentRunId: string,
  ): Promise<FeaturePhaseSessionHandle> {
    return Promise.resolve(this.createHandle(scope, { agentRunId }, payload));
  }

  async resume(
    scope: FeaturePhaseScope,
    run: { agentRunId: string; sessionId: string },
    payload: FeaturePhaseRunPayload,
  ): Promise<ResumeFeaturePhaseResult> {
    if (!supportsSessionResume(scope.phase)) {
      return {
        kind: 'not_resumable',
        sessionId: run.sessionId,
        reason: 'unsupported_by_harness',
      };
    }

    const messages = await this.sessionStore.load(run.sessionId);
    if (messages === null) {
      return {
        kind: 'not_resumable',
        sessionId: run.sessionId,
        reason: 'session_not_found',
      };
    }

    return {
      kind: 'resumed',
      handle: this.createHandle(scope, run, payload),
    };
  }

  private createHandle(
    scope: FeaturePhaseScope,
    run: { agentRunId: string; sessionId?: string },
    payload: FeaturePhaseRunPayload,
  ): FeaturePhaseSessionHandle {
    const feature = this.graph.features.get(scope.featureId);
    if (feature === undefined) {
      throw new Error(`feature "${scope.featureId}" not found`);
    }

    const runContext = this.createRunContext(run);
    const sessionId = runContext.sessionId ?? runContext.agentRunId;

    switch (scope.phase) {
      case 'discuss':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .discussFeature(feature, runContext)
            .then((result) => textPhaseOutcome('discuss', result)),
        });
      case 'research':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .researchFeature(feature, runContext)
            .then((result) => textPhaseOutcome('research', result)),
        });
      case 'plan': {
        if (this.agent.startPlanFeature !== undefined) {
          const session = this.agent.startPlanFeature(feature, runContext);
          return createProposalPhaseSessionHandle({
            sessionId,
            session,
            phase: 'plan',
          });
        }
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .planFeature(feature, runContext)
            .then((result) => proposalOutcome('plan', result)),
        });
      }
      case 'replan': {
        const reason =
          payload.replanReason ?? 'Scheduler requested replanning.';
        if (this.agent.startReplanFeature !== undefined) {
          const session = this.agent.startReplanFeature(
            feature,
            reason,
            runContext,
          );
          return createProposalPhaseSessionHandle({
            sessionId,
            session,
            phase: 'replan',
          });
        }
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .replanFeature(feature, reason, runContext)
            .then((result) => proposalOutcome('replan', result)),
        });
      }
      case 'verify':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .verifyFeature(feature, runContext)
            .then((verification) => verificationOutcome(verification)),
        });
      case 'ci_check':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.verification
            .verifyFeature(feature)
            .then((verification) => ciCheckOutcome(verification)),
        });
      case 'summarize':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .summarizeFeature(feature, runContext)
            .then((result) => textPhaseOutcome('summarize', result)),
        });
      default:
        throw new Error(
          `feature phase '${scope.phase}' not configured by DiscussFeaturePhaseBackend`,
        );
    }
  }

  private createRunContext(run: {
    agentRunId: string;
    sessionId?: string;
  }): FeaturePhaseRunContext {
    if (run.sessionId === undefined) {
      return { agentRunId: run.agentRunId };
    }

    return {
      agentRunId: run.agentRunId,
      sessionId: run.sessionId,
    };
  }
}

function textPhaseOutcome(
  phase: 'discuss' | 'research' | 'summarize',
  result: FeaturePhaseResult,
): FeaturePhaseDispatchOutcome {
  return {
    kind: 'completed_inline',
    output: {
      kind: 'text_phase',
      phase,
      result,
    },
  };
}

function proposalOutcome(
  phase: 'plan' | 'replan',
  result: ProposalPhaseResult,
): FeaturePhaseDispatchOutcome {
  return {
    kind: 'awaiting_approval',
    output: {
      kind: 'proposal',
      phase,
      result,
    },
  };
}

function verificationOutcome(
  verification: VerificationSummary,
): FeaturePhaseDispatchOutcome {
  return {
    kind: 'completed_inline',
    output: {
      kind: 'verification',
      verification,
    },
  };
}

function ciCheckOutcome(
  verification: VerificationSummary,
): FeaturePhaseDispatchOutcome {
  return {
    kind: 'completed_inline',
    output: {
      kind: 'ci_check',
      verification,
    },
  };
}

function supportsSessionResume(
  phase: FeaturePhaseScope['phase'],
): phase is 'discuss' | 'research' | 'plan' | 'replan' | 'summarize' {
  return (
    phase === 'discuss' ||
    phase === 'research' ||
    phase === 'plan' ||
    phase === 'replan' ||
    phase === 'summarize'
  );
}

export function createFeaturePhaseHandle(params: {
  sessionId: string;
  outcome: FeaturePhaseDispatchOutcome | Promise<FeaturePhaseDispatchOutcome>;
  harnessKind?: HarnessKind;
  workerPid?: number;
  workerBootEpoch?: number;
}): FeaturePhaseSessionHandle {
  const outcome = Promise.resolve(params.outcome);
  let exitInfo: SessionExitInfo | undefined;
  const exitHandlers: Array<(info: SessionExitInfo) => void> = [];

  const fireExit = (info: SessionExitInfo): void => {
    if (exitInfo !== undefined) {
      return;
    }
    exitInfo = info;
    for (const handler of exitHandlers) {
      handler(info);
    }
  };

  void outcome.then(
    () => {
      fireExit({ code: 0, signal: null });
    },
    (error: unknown) => {
      fireExit({
        code: 1,
        signal: null,
        error:
          error instanceof Error
            ? error
            : new Error(String(error ?? 'unknown')),
      });
    },
  );

  return {
    sessionId: params.sessionId,
    harnessKind: params.harnessKind ?? 'pi-sdk',
    ...(params.workerPid !== undefined ? { workerPid: params.workerPid } : {}),
    ...(params.workerBootEpoch !== undefined
      ? { workerBootEpoch: params.workerBootEpoch }
      : {}),
    abort(): void {
      // Synthetic handles have no subprocess to terminate.
    },
    sendInput(): Promise<void> {
      return Promise.resolve();
    },
    send(_message: OrchestratorToWorkerMessage): void {
      // Synthetic handles do not forward worker control messages.
    },
    onWorkerMessage(
      _handler: (message: WorkerToOrchestratorMessage) => void,
    ): void {
      // Synthetic handles do not emit worker messages.
    },
    onExit(handler: (info: SessionExitInfo) => void): void {
      if (exitInfo !== undefined) {
        handler(exitInfo);
        return;
      }
      exitHandlers.push(handler);
    },
    awaitOutcome(): Promise<FeaturePhaseDispatchOutcome> {
      return outcome;
    },
  } as FeaturePhaseSessionHandle;
}

/**
 * Builds a feature-phase handle backed by a {@link LiveProposalPhaseSession}.
 * sendInput delegates to {@link LiveProposalPhaseSession.sendUserMessage} so
 * planner chat input lands as a follow-up turn on the running agent. abort
 * routes to {@link LiveProposalPhaseSession.abort}. onWorkerMessage stays a
 * no-op until Phase 5 wires the agent event stream.
 */
export function createProposalPhaseSessionHandle(params: {
  sessionId: string;
  session: LiveProposalPhaseSession;
  phase: 'plan' | 'replan';
  harnessKind?: HarnessKind;
  workerPid?: number;
  workerBootEpoch?: number;
}): FeaturePhaseSessionHandle {
  const outcome = params.session
    .awaitOutcome()
    .then((result) => proposalOutcome(params.phase, result));
  let exitInfo: SessionExitInfo | undefined;
  const exitHandlers: Array<(info: SessionExitInfo) => void> = [];

  const fireExit = (info: SessionExitInfo): void => {
    if (exitInfo !== undefined) {
      return;
    }
    exitInfo = info;
    for (const handler of exitHandlers) {
      handler(info);
    }
  };

  void outcome.then(
    () => {
      fireExit({ code: 0, signal: null });
    },
    (error: unknown) => {
      fireExit({
        code: 1,
        signal: null,
        error:
          error instanceof Error
            ? error
            : new Error(String(error ?? 'unknown')),
      });
    },
  );

  return {
    sessionId: params.sessionId,
    harnessKind: params.harnessKind ?? 'pi-sdk',
    ...(params.workerPid !== undefined ? { workerPid: params.workerPid } : {}),
    ...(params.workerBootEpoch !== undefined
      ? { workerBootEpoch: params.workerBootEpoch }
      : {}),
    abort(): void {
      params.session.abort();
    },
    sendInput(text: string): Promise<void> {
      params.session.sendUserMessage(text);
      return Promise.resolve();
    },
    send(message: OrchestratorToWorkerMessage): void {
      // The in-process planner doesn't speak worker IPC, but help_response
      // arrives through the same RuntimePort.respondToRunHelp surface as
      // task workers, so route the typed message into the session's
      // respondToHelp registry. approval_decision is task-only today.
      if (message.type === 'help_response') {
        params.session.respondToHelp(message.toolCallId, message.response);
      }
    },
    onWorkerMessage(
      _handler: (message: WorkerToOrchestratorMessage) => void,
    ): void {
      // Phase 5 defers the Agent.subscribe → worker-message adapter for
      // attach observation; help-response routing flows through send()
      // above instead.
    },
    onExit(handler: (info: SessionExitInfo) => void): void {
      if (exitInfo !== undefined) {
        handler(exitInfo);
        return;
      }
      exitHandlers.push(handler);
    },
    awaitOutcome(): Promise<FeaturePhaseDispatchOutcome> {
      return outcome;
    },
    proposalSession: params.session,
  };
}
