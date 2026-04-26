import type { TaskResult } from '@core/types/index';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
} from '@runtime/contracts';

export type ClaimLockResult =
  | { granted: true }
  | { granted: false; deniedPaths: readonly string[] };

/**
 * Narrow seam that worker tools use to talk to the orchestrator.
 *
 * The `WorkerRuntime` owns the real transport and the pending-response map;
 * it constructs an `IpcBridge` per run and hands it to the toolset factory.
 * Tools never see the raw `ChildIpcTransport` — keeping the surface small
 * makes blocking tools easy to test against a mock bridge.
 */
export interface IpcBridge {
  readonly taskId: string;
  readonly agentRunId: string;

  /** Send a non-terminal progress notification. */
  progress(message: string): void;

  /** Block until the operator responds to a help request. */
  requestHelp(toolCallId: string, query: string): Promise<HelpResponse>;

  /** Block until the operator responds to an approval request. */
  requestApproval(
    toolCallId: string,
    payload: ApprovalPayload,
  ): Promise<ApprovalDecision>;

  /** Block until the orchestrator responds with a claim decision for the given paths. */
  claimLock(paths: readonly string[]): Promise<ClaimLockResult>;

  /** Emit the terminal task result. */
  submitResult(result: TaskResult): Promise<void>;
}
