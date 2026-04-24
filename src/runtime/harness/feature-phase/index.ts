import type { PlannerAgent } from '@agents/planner';
import type { FeatureGraph } from '@core/graph/index';
import type { FeaturePhaseRunContext } from '@core/types/index';
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
    private readonly agent: Pick<PlannerAgent, 'discussFeature'>,
    private readonly sessionStore: SessionStore,
  ) {}

  start(
    scope: FeaturePhaseScope,
    _payload: FeaturePhaseRunPayload,
    agentRunId: string,
  ): Promise<FeaturePhaseSessionHandle> {
    return Promise.resolve(this.createHandle(scope, { agentRunId }));
  }

  async resume(
    scope: FeaturePhaseScope,
    run: { agentRunId: string; sessionId: string },
    _payload: FeaturePhaseRunPayload,
  ): Promise<ResumeFeaturePhaseResult> {
    if (scope.phase !== 'discuss') {
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
      handle: this.createHandle(scope, run),
    };
  }

  private createHandle(
    scope: FeaturePhaseScope,
    run: { agentRunId: string; sessionId?: string },
  ): FeaturePhaseSessionHandle {
    if (scope.phase !== 'discuss') {
      throw new Error(
        `feature phase '${scope.phase}' not configured by DiscussFeaturePhaseBackend`,
      );
    }

    const feature = this.graph.features.get(scope.featureId);
    if (feature === undefined) {
      throw new Error(`feature "${scope.featureId}" not found`);
    }

    const runContext = this.createRunContext(run);
    return createFeaturePhaseHandle({
      sessionId: runContext.sessionId ?? runContext.agentRunId,
      outcome: this.agent
        .discussFeature(feature, runContext)
        .then((result) => ({
          kind: 'completed_inline',
          output: {
            kind: 'text_phase',
            phase: 'discuss',
            result,
          },
        })),
    });
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
