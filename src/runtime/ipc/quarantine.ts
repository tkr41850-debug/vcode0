import type { QuarantinedFrameEntry, Store } from '@orchestrator/ports/index';

/**
 * REQ-EXEC-03 quarantine: bounded in-memory ring + fire-and-forget persistence
 * for NDJSON IPC lines that fail to parse or validate against the typebox
 * frame schema. The orchestrator MUST NOT throw on malformed lines; instead
 * the line is recorded here and dropped.
 *
 * Design choices (per RESEARCH §Open Question #3):
 *   * Ring is authoritative for debugging — in-process visibility via
 *     `recent()` for TUI and tests.
 *   * Store write is `queueMicrotask` so a slow SQLite insert never stalls
 *     the hot readline handler. Errors from the Store are swallowed — the
 *     ring still has the data and the Store is a secondary surface.
 *   * `ringCapacity = 64` per RESEARCH §NDJSON IPC Framing.
 */

export type Direction = 'parent_from_child' | 'child_from_parent';

export interface QuarantineEntry {
  ts: number;
  direction: Direction;
  agentRunId?: string;
  raw: string;
  errorMessage: string;
}

export interface Quarantine {
  record(entry: QuarantineEntry): void;
  recent(): QuarantineEntry[];
}

export interface CreateQuarantineOptions {
  /** Omit in tests that don't care about persistence. */
  store?: Store;
  /** Default: 64. */
  ringCapacity?: number;
}

const DEFAULT_RING_CAPACITY = 64;

export function createQuarantine(
  opts: CreateQuarantineOptions = {},
): Quarantine {
  const capacity = opts.ringCapacity ?? DEFAULT_RING_CAPACITY;
  const ring: QuarantineEntry[] = [];
  const store = opts.store;

  return {
    record(entry: QuarantineEntry): void {
      // Copy incoming entry so the caller can't mutate ring contents later.
      const frozen: QuarantineEntry = { ...entry };
      ring.push(frozen);
      if (ring.length > capacity) ring.shift();

      if (store !== undefined) {
        // queueMicrotask keeps the readline hot path free of SQLite IO.
        // Any Store error is swallowed on purpose — the ring is the
        // authoritative debug surface. See RESEARCH Q#3.
        queueMicrotask(() => {
          try {
            const payload: QuarantinedFrameEntry = {
              ts: frozen.ts,
              direction: frozen.direction,
              raw: frozen.raw,
              errorMessage: frozen.errorMessage,
              ...(frozen.agentRunId !== undefined
                ? { agentRunId: frozen.agentRunId }
                : {}),
            };
            store.appendQuarantinedFrame(payload);
          } catch {
            /* fire-and-forget */
          }
        });
      }
    },

    recent(): QuarantineEntry[] {
      // Return a shallow copy so callers cannot mutate the live ring.
      return ring.map((entry) => ({ ...entry }));
    },
  };
}
