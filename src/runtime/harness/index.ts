import type { Task } from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';
import type { ResumableTaskExecutionRunRef } from '@runtime/contracts';

export interface SessionHandle {
  sessionId: string;
  abort(): void;
  sendInput(text: string): Promise<void>;
}

export type ResumeSessionResult =
  | {
      kind: 'resumed';
      handle: SessionHandle;
    }
  | {
      kind: 'not_resumable';
      sessionId: string;
      reason: 'session_not_found' | 'path_mismatch' | 'unsupported_by_harness';
    };

export interface SessionHarness {
  start(task: Task, context: WorkerContext): Promise<SessionHandle>;
  resume(
    task: Task,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult>;
}

export class PiSdkHarness implements SessionHarness {
  start(_task: Task, _context: WorkerContext): Promise<SessionHandle> {
    return Promise.resolve({
      sessionId: 'stub-session',
      abort() {},
      sendInput(_text: string) {
        return Promise.resolve();
      },
    });
  }

  resume(
    _task: Task,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult> {
    return Promise.resolve({
      kind: 'resumed',
      handle: {
        sessionId: run.sessionId,
        abort() {},
        sendInput(_text: string) {
          return Promise.resolve();
        },
      },
    });
  }
}
