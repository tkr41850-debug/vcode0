import type { QuarantinedFrameEntry } from '@core/types/index';

export type QuarantineSink = (
  entry: QuarantinedFrameEntry,
) => void | Promise<void>;

export interface QuarantineOptions {
  capacity?: number;
  sink?: QuarantineSink;
  now?: () => number;
}

const DEFAULT_CAPACITY = 64;

/**
 * Bounded in-process ring of recent malformed IPC frames. Each `record`
 * call appends to an in-memory buffer (newest-first via `recent()`) and
 * fires the optional sink for durable storage. Sink failures are logged
 * to stderr but never propagate — IPC handlers must remain best-effort.
 */
export class Quarantine {
  private readonly buffer: QuarantinedFrameEntry[] = [];
  private readonly capacity: number;
  private readonly sink: QuarantineSink | undefined;
  private readonly now: () => number;

  constructor(options: QuarantineOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.sink = options.sink;
    this.now = options.now ?? (() => Date.now());
  }

  record(entry: Omit<QuarantinedFrameEntry, 'ts'> & { ts?: number }): void {
    const stored: QuarantinedFrameEntry = {
      ts: entry.ts ?? this.now(),
      direction: entry.direction,
      ...(entry.agentRunId !== undefined
        ? { agentRunId: entry.agentRunId }
        : {}),
      raw: entry.raw,
      errorMessage: entry.errorMessage,
    };
    this.buffer.unshift(stored);
    if (this.buffer.length > this.capacity) {
      this.buffer.length = this.capacity;
    }
    if (this.sink === undefined) {
      return;
    }
    try {
      const ret = this.sink(stored);
      if (ret instanceof Promise) {
        ret.catch((err: unknown) => {
          process.stderr.write(
            `[ipc] quarantine sink rejected: ${stringifyError(err)}\n`,
          );
        });
      }
    } catch (err) {
      process.stderr.write(
        `[ipc] quarantine sink threw: ${stringifyError(err)}\n`,
      );
    }
  }

  recent(): readonly QuarantinedFrameEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
