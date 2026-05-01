import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { AgentRun, EventRecord } from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { SqliteStore } from '@persistence/sqlite-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Plan 02-02 Task 2: rehydration invariant on a real file DB.
 *
 * `shutdown() → open() → rehydrate()` must yield a value deep-equal to
 * the pre-shutdown snapshot. This exists on a real tmpdir file (not
 * `:memory:`) so WAL + fsync behaviour is exercised — see RESEARCH
 * Pitfall 6. Gates Phase 9 crash recovery.
 */

function usage() {
  return {
    llmCalls: 3,
    inputTokens: 200,
    outputTokens: 80,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 20,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens: 315,
    usd: 0.05,
    byModel: {
      'anthropic:claude-sonnet-4-6': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        llmCalls: 3,
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 20,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        totalTokens: 315,
        usd: 0.05,
      },
    },
  };
}

function seedAll(store: SqliteStore): void {
  // 1 milestone, 2 features (one blocked by the other), 3 tasks with a
  // task dependency, 1 feature dep, 5 agent_runs (one per open status),
  // 3 terminal runs (completed/failed/cancelled — must be filtered out of
  // openRuns), plus 10 events with varied types.
  const graph = store.graph();
  graph.createMilestone({
    id: 'm-1',
    name: 'M1',
    description: 'milestone one',
  });
  graph.createFeature({
    id: 'f-1',
    milestoneId: 'm-1',
    name: 'F1',
    description: 'feature one',
  });
  graph.createFeature({
    id: 'f-2',
    milestoneId: 'm-1',
    name: 'F2',
    description: 'feature two',
  });
  graph.addDependency({ from: 'f-2', to: 'f-1' });
  // Exercise `features.runtime_blocked_by_feature_id` (nullable self-ref FK).
  graph.editFeature('f-2', { runtimeBlockedByFeatureId: 'f-1' });

  // Task with reserved_write_paths JSON array.
  graph.createTask({
    id: 't-1',
    featureId: 'f-1',
    description: 'T1',
    reservedWritePaths: ['src/a.ts', 'src/b.ts'],
    objective: 'do the thing',
    expectedFiles: ['src/a.ts'],
    references: ['docs/foo.md'],
    outcomeVerification: 'npm test passes',
  });
  graph.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });
  graph.createTask({ id: 't-3', featureId: 'f-2', description: 'T3' });
  graph.addDependency({ from: 't-2', to: 't-1' });

  // agent_runs in every open status + three terminal statuses (so the
  // openRuns filter is exercised end-to-end via rehydrate()).
  const openStatuses: AgentRun['runStatus'][] = [
    'ready',
    'running',
    'retry_await',
    'await_response',
    'await_approval',
    'checkpointed_await_response',
    'checkpointed_await_approval',
  ];
  for (const s of openStatuses) {
    const run: AgentRun = {
      id: `run-${s}`,
      scopeType: 'task',
      scopeId: 't-1',
      phase: 'execute',
      runStatus: s,
      owner: 'system',
      attention: 'none',
      maxRetries: 3,
      restartCount: 0,
      payloadJson: JSON.stringify({ status: s }),
      tokenUsage: usage(),
    };
    store.createAgentRun(run);
  }
  const terminalStatuses: AgentRun['runStatus'][] = [
    'completed',
    'failed',
    'cancelled',
  ];
  for (const s of terminalStatuses) {
    const run: AgentRun = {
      id: `run-${s}`,
      scopeType: 'feature_phase',
      scopeId: 'f-1',
      phase: 'verify',
      runStatus: s,
      owner: 'manual',
      attention: 'none',
      maxRetries: 0,
      restartCount: 0,
    };
    store.createAgentRun(run);
  }

  const events: EventRecord[] = [
    {
      eventType: 'run.started',
      entityId: 't-1',
      timestamp: 1000,
      payload: { worker: 'w1' },
    },
    { eventType: 'run.progress', entityId: 't-1', timestamp: 1100 },
    {
      eventType: 'run.completed',
      entityId: 't-1',
      timestamp: 1200,
      payload: { exit: 0 },
    },
    {
      eventType: 'feature.phase',
      entityId: 'f-1',
      timestamp: 1300,
      payload: { phase: 'plan' },
    },
    {
      eventType: 'feature.phase',
      entityId: 'f-1',
      timestamp: 1400,
      payload: { phase: 'execute' },
    },
    { eventType: 'warn.budget', entityId: 'f-1', timestamp: 1500 },
    { eventType: 'merge.queued', entityId: 'f-2', timestamp: 1600 },
    { eventType: 'merge.completed', entityId: 'f-2', timestamp: 1700 },
    {
      eventType: 'schedule.tick',
      entityId: 'system',
      timestamp: 1800,
      payload: { ready: 2 },
    },
    {
      eventType: 'schedule.tick',
      entityId: 'system',
      timestamp: 1900,
      payload: { ready: 0 },
    },
  ];
  for (const e of events) {
    store.appendEvent(e);
  }
}

describe('Store rehydration invariant (real file DB)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gvc0-rehydrate-'));
    dbPath = join(dir, 'state.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('snapshot is deep-equal after close/reopen on real file DB', () => {
    const db1 = openDatabase(dbPath);
    const store1 = new SqliteStore(db1);
    seedAll(store1);
    const snapshot1 = store1.rehydrate();
    store1.close();

    const db2 = openDatabase(dbPath);
    const store2 = new SqliteStore(db2);
    const snapshot2 = store2.rehydrate();
    store2.close();

    // Deep-equal across all three top-level fields: graph, openRuns,
    // pendingEvents. Any non-determinism in snapshot ordering surfaces
    // here as an inequality.
    expect(isDeepStrictEqual(snapshot1, snapshot2)).toBe(true);
  });

  it('open → mutate → close → open → snapshot preserves mutations', () => {
    const db1 = openDatabase(dbPath);
    const store1 = new SqliteStore(db1);
    seedAll(store1);
    const before = store1.rehydrate();
    store1.close();

    // Reopen, add one more task, close.
    const db2 = openDatabase(dbPath);
    const store2 = new SqliteStore(db2);
    store2.graph().createTask({
      id: 't-added',
      featureId: 'f-2',
      description: 'added after reopen',
    });
    store2.close();

    // Reopen, assert the mutation AND the pre-mutation state are present.
    const db3 = openDatabase(dbPath);
    const store3 = new SqliteStore(db3);
    const after = store3.rehydrate();
    store3.close();

    const beforeTaskIds = before.graph.tasks.map((t) => t.id).sort();
    const afterTaskIds = after.graph.tasks.map((t) => t.id).sort();
    expect(afterTaskIds).toEqual([...beforeTaskIds, 't-added'].sort());

    // Pre-existing entities remain untouched (IDs + relationships).
    expect(after.graph.milestones.map((m) => m.id).sort()).toEqual(
      before.graph.milestones.map((m) => m.id).sort(),
    );
    expect(after.graph.features.map((f) => f.id).sort()).toEqual(
      before.graph.features.map((f) => f.id).sort(),
    );
    // Rehydrate-side invariants (openRuns / pendingEvents) carry over
    // byte-for-byte — we never touched runs or events in the middle
    // session.
    expect(isDeepStrictEqual(after.openRuns, before.openRuns)).toBe(true);
    expect(isDeepStrictEqual(after.pendingEvents, before.pendingEvents)).toBe(
      true,
    );
  });

  it('rehydrate() is idempotent — calling twice without close returns deep-equal results', () => {
    const db = openDatabase(dbPath);
    const store = new SqliteStore(db);
    try {
      seedAll(store);
      const s1 = store.rehydrate();
      const s2 = store.rehydrate();
      expect(isDeepStrictEqual(s1, s2)).toBe(true);
    } finally {
      store.close();
    }
  });
});
