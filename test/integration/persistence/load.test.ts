import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EventRecord } from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { SqliteStore } from '@persistence/sqlite-store';
import { describe, expect, it } from 'vitest';

/**
 * Plan 02-02 Task 3: sustained-write load test harness.
 *
 * Runs 100 ev/s × 10 min against a real-file SQLite DB and asserts
 * P95 write latency under 100 ms plus bounded WAL growth. Gated by the
 * LOAD_TEST=1 env flag — default `npm run test:integration` SKIPS this
 * suite (runtime ~10 min). See test/integration/persistence/README.md.
 *
 * Guardrails per RESEARCH notes:
 * - Real file DB via `mkdtempSync`, NOT `:memory:` (Pitfall 6 — fsync/WAL
 *   behaviour cannot be observed on in-memory databases).
 * - Per-write timing via `process.hrtime.bigint()` (nanosecond precision;
 *   avoids `console.time` GC-pause bias — see "Don't Hand-Roll" §).
 * - WAL growth sanity ceiling is 20 MB (Pitfall 1 — unbounded WAL is the
 *   characteristic failure mode for sustained writes).
 */

const LOAD_TEST_ENABLED = process.env.LOAD_TEST === '1';
const TARGET_RATE_HZ = 100;
const DURATION_MS = 10 * 60 * 1000; // 10 minutes
const P95_BUDGET_MS = 100;
const WAL_SIZE_CEILING_BYTES = 20 * 1024 * 1024; // 20 MB

describe.skipIf(!LOAD_TEST_ENABLED)(
  'persistence load test (LOAD_TEST=1)',
  () => {
    it('sustains 100 ev/s for 10 min with P95 < 100 ms', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gvc0-load-'));
      const dbPath = join(dir, 'state.db');
      try {
        const db = openDatabase(dbPath);
        const store = new SqliteStore(db);
        // Seed a milestone + feature so events have a valid entity_id
        // anchor (events.entity_id is not an enforced FK but keeping the
        // reference realistic exercises the real write path).
        store.graph().createMilestone({
          id: 'm-seed',
          name: 'seed',
          description: 'load-test seed milestone',
        });
        store.graph().createFeature({
          id: 'f-seed',
          milestoneId: 'm-seed',
          name: 'seed-feature',
          description: 'load-test seed feature',
        });

        const samplesNs: number[] = [];
        const deadline = Date.now() + DURATION_MS;
        const intervalMs = 1000 / TARGET_RATE_HZ;

        while (Date.now() < deadline) {
          const event: EventRecord = {
            eventType: 'load-synthetic',
            entityId: 'f-seed',
            timestamp: Date.now(),
            payload: { seq: samplesNs.length, ts: Date.now() },
          };

          const t0 = process.hrtime.bigint();
          store.appendEvent(event);
          const elapsedNs = Number(process.hrtime.bigint() - t0);
          samplesNs.push(elapsedNs);

          // Pace: sleep just enough to target 100 Hz (accounting for
          // write duration). If the write took longer than the target
          // interval, proceed immediately.
          const elapsedMs = elapsedNs / 1e6;
          const sleepMs = Math.max(0, intervalMs - elapsedMs);
          if (sleepMs > 0) {
            await new Promise((r) => setTimeout(r, sleepMs));
          }
        }

        // Percentile recorder (sorted-copy approach — nsample * log(nsample)
        // is trivial for 60k samples).
        const sorted = [...samplesNs].sort((a, b) => a - b);
        const pctNs = (p: number): number => {
          const idx = Math.floor((sorted.length - 1) * p);
          return sorted[idx] ?? 0;
        };
        const p50ms = pctNs(0.5) / 1e6;
        const p95ms = pctNs(0.95) / 1e6;
        const p99ms = pctNs(0.99) / 1e6;
        // eslint-disable-next-line no-console
        console.log(
          `[load] samples=${samplesNs.length} P50=${p50ms.toFixed(2)}ms ` +
            `P95=${p95ms.toFixed(2)}ms P99=${p99ms.toFixed(2)}ms`,
        );

        // WAL growth sanity observation. `-wal` may already be
        // checkpointed to a smaller size by the time we stat; treat
        // ENOENT as "zero observed" which still satisfies the ceiling.
        const walPath = `${dbPath}-wal`;
        let walBytes = 0;
        try {
          walBytes = statSync(walPath).size;
        } catch {
          walBytes = 0;
        }
        // eslint-disable-next-line no-console
        console.log(`[load] WAL size at end = ${walBytes} bytes`);

        // Volume: allow 10% slack on the target rate to account for
        // scheduler jitter on busy CI runners.
        expect(samplesNs.length).toBeGreaterThanOrEqual(
          Math.floor(TARGET_RATE_HZ * (DURATION_MS / 1000) * 0.9),
        );
        // Latency budget: the P95 assertion is the phase gate for
        // Phase 2 SC #2.
        expect(p95ms).toBeLessThan(P95_BUDGET_MS);
        // WAL growth ceiling: catches auto-checkpoint stalls under
        // sustained write pressure (RESEARCH Pitfall 1).
        expect(walBytes).toBeLessThan(WAL_SIZE_CEILING_BYTES);

        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, DURATION_MS + 60_000); // Vitest timeout: duration + 1 min slack.
  },
);
