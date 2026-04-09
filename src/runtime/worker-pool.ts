import type { Task } from '@core/types/index';
import type {
  RuntimeDispatchOptions,
  RuntimePort,
} from '@orchestrator/ports/index';
import type { SessionHarness } from '@runtime/harness/index';

export interface WorkerHandle {
  taskId: string;
  sessionId?: string;
}

export class LocalWorkerPool implements RuntimePort {
  constructor(private readonly harness: SessionHarness) {}

  dispatchTask(_task: Task, _options?: RuntimeDispatchOptions): Promise<void> {
    void this.harness;
    return Promise.resolve();
  }

  suspendTask(
    _taskId: string,
    _reason: string,
    _files?: string[],
  ): Promise<void> {
    void this.harness;
    return Promise.resolve();
  }

  resumeTask(_taskId: string, _reason: string): Promise<void> {
    void this.harness;
    return Promise.resolve();
  }

  abortTask(_taskId: string): Promise<void> {
    void this.harness;
    return Promise.resolve();
  }

  stopAll(): Promise<void> {
    void this.harness;
    return Promise.resolve();
  }
}
