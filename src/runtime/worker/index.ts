import type { Task } from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';
import type { SessionHarness } from '@runtime/harness/index';
import type { IpcTransport, OrchestratorMessage } from '@runtime/ipc/index';

export class WorkerRuntime {
  constructor(
    private readonly transport: IpcTransport,
    private readonly harness: SessionHarness,
  ) {}

  run(_task: Task, _context: WorkerContext): Promise<void> {
    void this.transport;
    void this.harness;
    return Promise.resolve();
  }

  handleMessage(_message: OrchestratorMessage): void {
    void this.transport;
  }
}
