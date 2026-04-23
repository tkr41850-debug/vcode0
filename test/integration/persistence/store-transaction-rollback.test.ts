import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { openDatabase } from '@persistence/db';
import { SqliteStore } from '@persistence/sqlite-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Integration coverage for Plan 02-01 Task 5 rollback contract:
 *
 *  "A failing mutation inside the Store's public surface must leave the
 *   in-memory FeatureGraph snapshot AND the SQLite file byte-equivalent
 *   to the pre-call state; reopening the file must replay the same
 *   snapshot."
 *
 * Uses a real file-backed DB (WAL fsync behaviour cannot be exercised on
 * `:memory:` — see migration-forward-only.test.ts for the companion
 * forward-only runner coverage).
 */
describe('SqliteStore transaction rollback (real file DB)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gvc0-store-rb-'));
    dbPath = join(dir, 'state.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rolls back graph + DB when a cross-feature task dep is rejected', () => {
    const db = openDatabase(dbPath);
    const store = new SqliteStore(db);

    try {
      const graph = store.graph();
      graph.createMilestone({ id: 'm-1', name: 'M1', description: 'desc' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F1',
        description: 'd',
      });
      graph.createFeature({
        id: 'f-2',
        milestoneId: 'm-1',
        name: 'F2',
        description: 'd',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      graph.createTask({ id: 't-2', featureId: 'f-2', description: 'T2' });

      const preSnapshot = store.snapshotGraph();
      const preTaskCount = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tasks')
        .get();
      const preDepCount = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM dependencies')
        .get();

      // Cross-feature task dep is a graph validation violation — the
      // snapshot-diff-rollback path in PersistentFeatureGraph must leave
      // both the in-memory graph and the SQL file untouched.
      expect(() =>
        graph.addDependency({ from: 't-2', to: 't-1' }),
      ).toThrow();

      const postSnapshot = store.snapshotGraph();
      expect(isDeepStrictEqual(postSnapshot, preSnapshot)).toBe(true);

      const postTaskCount = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tasks')
        .get();
      const postDepCount = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM dependencies')
        .get();
      expect(postTaskCount?.c).toBe(preTaskCount?.c);
      expect(postDepCount?.c).toBe(preDepCount?.c);
    } finally {
      store.close();
    }
  });

  it('persists the pre-failure snapshot across close + reopen', () => {
    // First session: seed graph, trigger a failed mutation, close.
    const db1 = openDatabase(dbPath);
    const store1 = new SqliteStore(db1);
    try {
      const graph = store1.graph();
      graph.createMilestone({ id: 'm-1', name: 'M1', description: 'desc' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F1',
        description: 'd',
      });
      graph.createFeature({
        id: 'f-2',
        milestoneId: 'm-1',
        name: 'F2',
        description: 'd',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      graph.createTask({ id: 't-2', featureId: 'f-2', description: 'T2' });

      const preFail = store1.snapshotGraph();
      expect(() =>
        graph.addDependency({ from: 't-2', to: 't-1' }),
      ).toThrow();

      // Post-fail snapshot from the live in-memory graph must match
      // pre-fail exactly — confirms the rollback path restores state in
      // process.
      const afterFail = store1.snapshotGraph();
      expect(isDeepStrictEqual(afterFail, preFail)).toBe(true);
    } finally {
      store1.close();
    }

    // Second session: reopen the same file, rehydrate through the codec
    // path, and compare ID sets + per-entity fields. We compare structural
    // identity (IDs, relationships, descriptions) rather than byte-for-byte
    // deep-equal because the InMemoryFeatureGraph constructor omits some
    // default-valued numeric fields (e.g. mergeTrainReentryCount=0,
    // consecutiveFailures=0) that the row codec materialises on replay —
    // both shapes are semantically equivalent.
    const db2 = openDatabase(dbPath);
    const store2 = new SqliteStore(db2);
    try {
      const replayed = store2.snapshotGraph();

      expect(replayed.milestones.map((m) => m.id).sort()).toEqual(['m-1']);
      expect(replayed.features.map((f) => f.id).sort()).toEqual([
        'f-1',
        'f-2',
      ]);
      expect(replayed.tasks.map((t) => t.id).sort()).toEqual(['t-1', 't-2']);

      for (const f of replayed.features) {
        expect(f.milestoneId).toBe('m-1');
        expect(f.dependsOn).toEqual([]);
      }
      for (const t of replayed.tasks) {
        expect(t.dependsOn).toEqual([]);
      }

      // The rejected dependency must not appear after reopen.
      const depCount = db2
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM dependencies')
        .get();
      expect(depCount?.c).toBe(0);

      // rehydrate() must echo the same replayed graph and carry empty
      // open-run / pending-event lists since no agent_runs or events were
      // written.
      const rehydrate = store2.rehydrate();
      expect(isDeepStrictEqual(rehydrate.graph, replayed)).toBe(true);
      expect(rehydrate.openRuns).toEqual([]);
      expect(rehydrate.pendingEvents).toEqual([]);
    } finally {
      store2.close();
    }
  });

  it('close() tears down the underlying connection', () => {
    const db = openDatabase(dbPath);
    const store = new SqliteStore(db);
    store.graph().createMilestone({
      id: 'm-1',
      name: 'M',
      description: 'd',
    });
    store.close();

    // better-sqlite3 rejects prepared-statement use after close().
    expect(() =>
      db.prepare('SELECT 1').get(),
    ).toThrow();
  });
});
