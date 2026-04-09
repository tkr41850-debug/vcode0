import type {
  ConflictSteeringContext,
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';

export interface ProviderUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  totalTokens: number;
  usd: number;
  rawUsage?: unknown;
}

export type WorkerMessage =
  | {
      type: 'status';
      taskId: string;
      status: Task['status'];
    }
  | { type: 'progress'; taskId: string; message: string }
  | { type: 'result'; taskId: string; summary: string; filesChanged: string[] }
  | { type: 'error'; taskId: string; error: string }
  | { type: 'cost'; taskId: string; usage: ProviderUsage };

export type OrchestratorMessage =
  | { type: 'run'; task: Task; context: WorkerContext }
  | { type: 'abort'; taskId: string }
  | { type: 'steer'; taskId: string; context: ConflictSteeringContext }
  | {
      type: 'suspend';
      taskId: string;
      reason: TaskSuspendReason;
      files: string[];
    }
  | { type: 'resume'; taskId: string; reason: TaskResumeReason };

export interface IpcTransport {
  send(message: OrchestratorMessage): void;
  onMessage(handler: (message: WorkerMessage) => void): void;
  close(): void;
}

export class NdjsonStdioTransport implements IpcTransport {
  send(_message: OrchestratorMessage): void {}

  onMessage(_handler: (message: WorkerMessage) => void): void {}

  close(): void {}
}

export class UnixSocketTransport implements IpcTransport {
  send(_message: OrchestratorMessage): void {}

  onMessage(_handler: (message: WorkerMessage) => void): void {}

  close(): void {}
}
