import type { Task } from '@core/types/index';
import type { Agent } from '@mariozechner/pi-agent-core';
import type { WorkerContext } from '@runtime/context/index';

export interface SessionHandle {
  sessionId: string;
  agent: Agent | undefined;
  abort(): void;
}

export interface SessionHarness {
  start(task: Task, context: WorkerContext): Promise<SessionHandle>;
  resume(sessionId: string, task: Task): Promise<SessionHandle>;
  persist(handle: SessionHandle): Promise<void>;
}

export class PiSdkHarness implements SessionHarness {
  start(_task: Task, _context: WorkerContext): Promise<SessionHandle> {
    return Promise.resolve({
      sessionId: 'stub-session',
      agent: undefined,
      abort() {},
    });
  }

  resume(_sessionId: string, _task: Task): Promise<SessionHandle> {
    return Promise.resolve({
      sessionId: 'stub-session',
      agent: undefined,
      abort() {},
    });
  }

  persist(_handle: SessionHandle): Promise<void> {
    return Promise.resolve();
  }
}
