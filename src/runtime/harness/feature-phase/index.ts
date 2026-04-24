import type { PlannerAgent } from '@agents/planner';
import type { ProposalPhaseResult } from '@agents/proposal';
import type { ReplannerAgent } from '@agents/replanner';
import type { FeatureGraph } from '@core/graph/index';
import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
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
      Pick<ReplannerAgent, 'replanFeature'>,
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
      case 'plan':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .planFeature(feature, runContext)
            .then((result) => proposalOutcome('plan', result)),
        });
      case 'replan':
        return createFeaturePhaseHandle({
          sessionId,
          outcome: this.agent
            .replanFeature(
              feature,
              payload.replanReason ?? 'Scheduler requested replanning.',
              runContext,
            )
            .then((result) => proposalOutcome('replan', result)),
        });
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
  };
}
