import type { TaskResult } from '@core/types/index';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
} from '@runtime/contracts';

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
  requestHelp(query: string): Promise<HelpResponse>;

  /** Block until the operator responds to an approval request. */
  requestApproval(payload: ApprovalPayload): Promise<ApprovalDecision>;

  /** Emit the terminal task result. */
  submitResult(result: TaskResult): void;
}
