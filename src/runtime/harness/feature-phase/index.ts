import type {
  FeaturePhaseRunPayload,
  OrchestratorToWorkerMessage,
  PhaseOutput,
  RunScope,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { SessionExitInfo, SessionHandle } from '@runtime/harness/index';

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
