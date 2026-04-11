import { randomUUID } from 'node:crypto';
import type { Task } from '@core/types/index';
import {
  Agent,
  type AgentOptions,
  type StreamFn,
} from '@mariozechner/pi-agent-core';
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

export interface PiSdkHarnessOptions {
  streamFn: StreamFn;
}

export class PiSdkHarness implements SessionHarness {
  private readonly streamFn: StreamFn;

  constructor(options: PiSdkHarnessOptions) {
    this.streamFn = options.streamFn;
  }

  async start(_task: Task, _context: WorkerContext): Promise<SessionHandle> {
    const sessionId = randomUUID();
    const agent = this.createAgent({ sessionId });

    return {
      sessionId,
      abort() {
        agent.abort();
      },
      sendInput(text: string) {
        return agent.prompt(text);
      },
    };
  }

  async resume(
    _task: Task,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult> {
    const agent = this.createAgent({ sessionId: run.sessionId });

    return {
      kind: 'resumed',
      handle: {
        sessionId: run.sessionId,
        abort() {
          agent.abort();
        },
        sendInput(text: string) {
          return agent.prompt(text);
        },
      },
    };
  }

  private createAgent(options: Partial<AgentOptions>): Agent {
    return new Agent({
      streamFn: this.streamFn,
      ...options,
    });
  }
}
