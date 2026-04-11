import type { Task } from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';
import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { SessionHandle, SessionHarness } from '@runtime/harness/index';
import type { WorkerIpcTransport } from '@runtime/ipc/index';

export class WorkerRuntime {
  private readonly sessions = new Map<string, SessionHandle>();

  constructor(
    private readonly transport: WorkerIpcTransport,
    private readonly harness: SessionHarness,
  ) {
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  handleMessage(message: OrchestratorToWorkerMessage): void {
    switch (message.type) {
      case 'run':
        void this.handleRun(message);
        break;
      case 'abort':
        this.handleAbort(message.taskId);
        break;
      case 'manual_input':
        void this.handleManualInput(message.taskId, message.text);
        break;
      case 'steer':
      case 'suspend':
      case 'resume':
      case 'help_response':
      case 'approval_decision':
        break;
    }
  }

  private async handleRun(
    message: Extract<OrchestratorToWorkerMessage, { type: 'run' }>,
  ): Promise<void> {
    const { taskId, agentRunId, dispatch, task, context } = message;

    try {
      let handle: SessionHandle;

      if (dispatch.mode === 'resume') {
        const result = await this.harness.resume(task, {
          taskId,
          agentRunId,
          sessionId: dispatch.sessionId,
        });
        if (result.kind === 'not_resumable') {
          this.send({
            type: 'error',
            taskId,
            agentRunId,
            error: `Session not resumable: ${result.reason}`,
          });
          return;
        }
        handle = result.handle;
      } else {
        handle = await this.harness.start(task, context);
      }

      this.sessions.set(taskId, handle);

      this.send({
        type: 'progress',
        taskId,
        agentRunId,
        message: `Session ${handle.sessionId} active`,
      });
    } catch (err) {
      this.send({
        type: 'error',
        taskId,
        agentRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleAbort(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session) {
      session.abort();
      this.sessions.delete(taskId);
    }
  }

  private async handleManualInput(taskId: string, text: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session) {
      await session.sendInput(text);
    }
  }

  private send(message: WorkerToOrchestratorMessage): void {
    this.transport.send(message);
  }

  run(_task: Task, _context: WorkerContext): Promise<void> {
    return Promise.resolve();
  }
}
