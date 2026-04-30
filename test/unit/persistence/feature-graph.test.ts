import assert from 'node:assert/strict';

import type { TokenUsageAggregate } from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function usageAggregate(usd: number, llmCalls = 1): TokenUsageAggregate {
  const inputTokens = 10 * llmCalls;
  const outputTokens = 5 * llmCalls;
  const totalTokens = inputTokens + outputTokens;

  return {
    llmCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens,
    usd,
    byModel: {
      'anthropic:claude-sonnet-4-6': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        llmCalls,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        totalTokens,
        usd,
      },
    },
  };
}

describe('PersistentFeatureGraph', () => {
  let db: Database.Database;
  let graph: PersistentFeatureGraph;
  let clock = 1_000_000;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 1_000_000;
    db = openDatabase(':memory:');
    graph = new PersistentFeatureGraph(db, now);
    graph.__enterTick();
  });

  afterEach(() => {
    db.close();
  });

  describe('entity persistence', () => {
    it('persists a newly created milestone', () => {
      graph.createMilestone({ id: 'm-1', name: 'M1', description: 'desc' });

      const rows = db
        .prepare<[], { id: string; name: string }>(
          'SELECT id, name FROM milestones',
        )
        .all();
      expect(rows).toEqual([{ id: 'm-1', name: 'M1' }]);
    });

    it('persists features and their milestone linkage', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Feature One',
        description: 'feature desc',
      });

      const row = db
        .prepare<[string], { id: string; milestone_id: string; name: string }>(
          'SELECT id, milestone_id, name FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(row).toEqual({
        id: 'f-1',
        milestone_id: 'm-1',
        name: 'Feature One',
      });
    });

    it('persists tasks with their owning feature', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });
      graph.createTask({
        id: 't-1',
        featureId: 'f-1',
        description: 'Task one',
      });

      const row = db
        .prepare<
          [string],
          { id: string; feature_id: string; description: string }
        >('SELECT id, feature_id, description FROM tasks WHERE id = ?')
        .get('t-1');
      expect(row).toEqual({
        id: 't-1',
        feature_id: 'f-1',
        description: 'Task one',
      });
    });

    it('persists feature and task dependencies as rows', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
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
        dependsOn: ['f-1'],
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      graph.createTask({
        id: 't-2',
        featureId: 'f-1',
        description: 'T2',
        dependsOn: ['t-1'],
      });

      const depRows = db
        .prepare<[], { from_id: string; to_id: string; dep_type: string }>(
          'SELECT from_id, to_id, dep_type FROM dependencies ORDER BY from_id',
        )
        .all();
      expect(depRows).toEqual([
        { from_id: 'f-2', to_id: 'f-1', dep_type: 'feature' },
        { from_id: 't-2', to_id: 't-1', dep_type: 'task' },
      ]);
    });

    it('persists runtimeBlockedByFeatureId edits on features', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
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

      graph.editFeature('f-1', { runtimeBlockedByFeatureId: 'f-2' });

      const row = db
        .prepare<[string], { runtime_blocked_by_feature_id: string | null }>(
          'SELECT runtime_blocked_by_feature_id FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(row?.runtime_blocked_by_feature_id).toBe('f-2');

      graph.editFeature('f-1', { runtimeBlockedByFeatureId: undefined });

      const cleared = db
        .prepare<[string], { runtime_blocked_by_feature_id: string | null }>(
          'SELECT runtime_blocked_by_feature_id FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(cleared?.runtime_blocked_by_feature_id).toBeNull();
    });

    it('persists removeFeature across features, tasks, and dependency rows', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
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
        dependsOn: ['f-1'],
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      graph.createTask({
        id: 't-2',
        featureId: 'f-1',
        description: 'T2',
        dependsOn: ['t-1'],
      });

      graph.removeFeature('f-1');

      const featureCount = db
        .prepare<[string], { c: number }>(
          'SELECT COUNT(*) AS c FROM features WHERE id = ?',
        )
        .get('f-1');
      const taskCount = db
        .prepare<[string], { c: number }>(
          'SELECT COUNT(*) AS c FROM tasks WHERE feature_id = ?',
        )
        .get('f-1');
      const depCount = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM dependencies')
        .get();

      expect(featureCount?.c).toBe(0);
      expect(taskCount?.c).toBe(0);
      expect(depCount?.c).toBe(0);
      expect(
        new PersistentFeatureGraph(db).features.get('f-2')?.dependsOn,
      ).toEqual([]);
    });

    it('persists editTask field updates', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });

      graph.editTask('t-1', {
        description: 'Updated task',
        weight: 'heavy',
        reservedWritePaths: ['src/updated.ts'],
      });

      const row = db
        .prepare<
          [string],
          {
            description: string;
            weight: string | null;
            reserved_write_paths: string | null;
          }
        >(
          'SELECT description, weight, reserved_write_paths FROM tasks WHERE id = ?',
        )
        .get('t-1');
      expect(row).toEqual({
        description: 'Updated task',
        weight: 'heavy',
        reserved_write_paths: JSON.stringify(['src/updated.ts']),
      });
    });

    it('persists replaceUsageRollups and clears omitted token usage', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      graph.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });

      graph.replaceUsageRollups({
        features: {
          'f-1': usageAggregate(5.5, 2),
        },
        tasks: {
          't-1': usageAggregate(1.25),
          't-2': usageAggregate(2.75, 3),
        },
      });

      let featureRow = db
        .prepare<[string], { token_usage: string | null }>(
          'SELECT token_usage FROM features WHERE id = ?',
        )
        .get('f-1');
      let taskRows = db
        .prepare<[], { id: string; token_usage: string | null }>(
          'SELECT id, token_usage FROM tasks ORDER BY id',
        )
        .all();
      expect(featureRow?.token_usage).toBe(
        JSON.stringify(usageAggregate(5.5, 2)),
      );
      expect(taskRows).toEqual([
        { id: 't-1', token_usage: JSON.stringify(usageAggregate(1.25)) },
        { id: 't-2', token_usage: JSON.stringify(usageAggregate(2.75, 3)) },
      ]);

      graph.replaceUsageRollups({
        features: {},
        tasks: {
          't-2': usageAggregate(4),
        },
      });

      featureRow = db
        .prepare<[string], { token_usage: string | null }>(
          'SELECT token_usage FROM features WHERE id = ?',
        )
        .get('f-1');
      taskRows = db
        .prepare<[], { id: string; token_usage: string | null }>(
          'SELECT id, token_usage FROM tasks ORDER BY id',
        )
        .all();
      expect(featureRow?.token_usage).toBeNull();
      expect(taskRows).toEqual([
        { id: 't-1', token_usage: null },
        { id: 't-2', token_usage: JSON.stringify(usageAggregate(4)) },
      ]);

      const rehydrated = new PersistentFeatureGraph(db);
      expect(rehydrated.features.get('f-1')?.tokenUsage).toBeUndefined();
      expect(rehydrated.tasks.get('t-1')?.tokenUsage).toBeUndefined();
      expect(rehydrated.tasks.get('t-2')?.tokenUsage).toEqual(
        usageAggregate(4),
      );
    });

    it('persists feature transition (status change)', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });

      graph.transitionFeature('f-1', { status: 'in_progress' });

      const row = db
        .prepare<[string], { status: string }>(
          'SELECT status FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(row?.status).toBe('in_progress');
    });

    it('persists cancelFeature(cascade) across feature and tasks', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });

      graph.cancelFeature('f-1', true);

      const feat = db
        .prepare<[string], { collab_status: string }>(
          'SELECT collab_status FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(feat?.collab_status).toBe('cancelled');

      const task = db
        .prepare<[string], { status: string }>(
          'SELECT status FROM tasks WHERE id = ?',
        )
        .get('t-1');
      expect(task?.status).toBe('cancelled');
    });

    it('persists cleared feature runtime block and preserved task suspend metadata on cancel', () => {
      graph.createMilestone({ id: 'm-1', name: 'M1', description: 'd' });
      graph.createMilestone({ id: 'm-2', name: 'M2', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F1',
        description: 'd',
      });
      graph.createFeature({
        id: 'f-2',
        milestoneId: 'm-2',
        name: 'F2',
        description: 'd',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      const task = graph.tasks.get('t-1');
      assert(task !== undefined, 'missing t-1 fixture');
      graph.tasks.set('t-1', {
        ...task,
        status: 'running',
        collabControl: 'suspended',
        suspendReason: 'cross_feature_overlap',
        suspendedAt: 1000,
        suspendedFiles: ['src/a.ts'],
        blockedByFeatureId: 'f-2',
      });
      graph.editFeature('f-1', { runtimeBlockedByFeatureId: 'f-2' });

      graph.cancelFeature('f-1');

      const featureRow = db
        .prepare<
          [string],
          {
            collab_status: string;
            runtime_blocked_by_feature_id: string | null;
          }
        >(
          'SELECT collab_status, runtime_blocked_by_feature_id FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(featureRow).toEqual({
        collab_status: 'cancelled',
        runtime_blocked_by_feature_id: null,
      });

      const taskRow = db
        .prepare<
          [string],
          {
            status: string;
            collab_status: string;
            suspend_reason: string | null;
            suspended_at: number | null;
            blocked_by_feature_id: string | null;
            suspended_files: string | null;
          }
        >(
          'SELECT status, collab_status, suspend_reason, suspended_at, blocked_by_feature_id, suspended_files FROM tasks WHERE id = ?',
        )
        .get('t-1');
      expect(taskRow).toEqual({
        status: 'cancelled',
        collab_status: 'suspended',
        suspend_reason: 'cross_feature_overlap',
        suspended_at: 1000,
        blocked_by_feature_id: 'f-2',
        suspended_files: '["src/a.ts"]',
      });
    });

    it('removes rows from dependencies table on removeDependency', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
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
        dependsOn: ['f-1'],
      });

      graph.removeDependency({ from: 'f-2', to: 'f-1' });

      const count = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM dependencies')
        .get();
      expect(count?.c).toBe(0);
    });
  });

  describe('recovery / round-trip', () => {
    it('reloads state when a second PersistentFeatureGraph is constructed on the same db', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'first',
      });
      graph.createFeature({
        id: 'f-2',
        milestoneId: 'm-1',
        name: 'Blocked By',
        description: 'second',
      });
      graph.editFeature('f-1', { runtimeBlockedByFeatureId: 'f-2' });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      graph.createTask({
        id: 't-2',
        featureId: 'f-1',
        description: 'T2',
        dependsOn: ['t-1'],
      });

      const graph2 = new PersistentFeatureGraph(db);
      expect(graph2.milestones.get('m-1')?.name).toBe('M');
      const feat = graph2.features.get('f-1');
      expect(feat?.description).toBe('first');
      expect(feat?.runtimeBlockedByFeatureId).toBe('f-2');
      const t2 = graph2.tasks.get('t-2');
      expect(t2?.dependsOn).toEqual(['t-1']);
    });

    it('round-trips feature-phase outputs and planner-baked task payload', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Auth',
        description: 'login flow',
      });
      graph.editFeature('f-1', {
        roughDraft: 'draft v1',
        discussOutput:
          '## Success Criteria\n- only email/password\n- bcrypt hashes',
        researchOutput:
          '## Essential Files\n- `src/auth/login.ts` — login handler',
        featureObjective: 'ship secure login',
        featureDoD: ['login works', 'tests green'],
        verifyIssues: [
          {
            source: 'verify',
            id: 'vi-1',
            severity: 'blocking',
            description: 'missing rate limit',
          },
        ],
      });
      graph.createTask({
        id: 't-1',
        featureId: 'f-1',
        description: 'add login endpoint',
        objective: 'handle POST /login',
        scope: 'server only',
        expectedFiles: ['src/auth/login.ts'],
        references: ['docs/auth/flow.md'],
        outcomeVerification: 'curl returns 200',
      });

      const graph2 = new PersistentFeatureGraph(db);
      const f = graph2.features.get('f-1');
      expect(f?.roughDraft).toBe('draft v1');
      expect(f?.discussOutput).toBe(
        '## Success Criteria\n- only email/password\n- bcrypt hashes',
      );
      expect(f?.researchOutput).toBe(
        '## Essential Files\n- `src/auth/login.ts` — login handler',
      );
      expect(f?.featureObjective).toBe('ship secure login');
      expect(f?.featureDoD).toEqual(['login works', 'tests green']);
      expect(f?.verifyIssues).toEqual([
        {
          source: 'verify',
          id: 'vi-1',
          severity: 'blocking',
          description: 'missing rate limit',
        },
      ]);

      const t = graph2.tasks.get('t-1');
      expect(t?.objective).toBe('handle POST /login');
      expect(t?.scope).toBe('server only');
      expect(t?.expectedFiles).toEqual(['src/auth/login.ts']);
      expect(t?.references).toEqual(['docs/auth/flow.md']);
      expect(t?.outcomeVerification).toBe('curl returns 200');
    });
  });

  describe('rollback on FSM rejection', () => {
    it('does not touch the db when the inner graph rejects a mutation', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });

      // Attempt to create a task against a missing feature — FSM throws
      // before the diff writer ever runs.
      expect(() =>
        graph.createTask({
          id: 't-1',
          featureId: 'f-missing',
          description: 'T1',
        }),
      ).toThrow();

      // Inner state untouched.
      expect(graph.tasks.size).toBe(0);

      // Row count in tasks table unchanged (still zero).
      const row = db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM tasks')
        .get();
      expect(row?.c).toBe(0);
    });
  });

  describe('steering queue round-trip', () => {
    it('persists steering_queue_position set by queueMilestone', () => {
      graph.createMilestone({ id: 'm-1', name: 'M1', description: 'd' });
      graph.createMilestone({ id: 'm-2', name: 'M2', description: 'd' });
      graph.queueMilestone('m-1');
      graph.queueMilestone('m-2');

      const rows = db
        .prepare<[], { id: string; steering_queue_position: number | null }>(
          'SELECT id, steering_queue_position FROM milestones ORDER BY id',
        )
        .all();
      expect(rows).toEqual([
        { id: 'm-1', steering_queue_position: 0 },
        { id: 'm-2', steering_queue_position: 1 },
      ]);

      graph.dequeueMilestone('m-1');
      const m1 = db
        .prepare<[string], { steering_queue_position: number | null }>(
          'SELECT steering_queue_position FROM milestones WHERE id = ?',
        )
        .get('m-1');
      expect(m1?.steering_queue_position).toBeNull();
    });
  });

  describe('created_at stability', () => {
    it('preserves the original created_at across upserts with a later clock', () => {
      clock = 1_000;
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });

      const initial = db
        .prepare<[string], { created_at: number; updated_at: number }>(
          'SELECT created_at, updated_at FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(initial?.created_at).toBe(1_000);
      expect(initial?.updated_at).toBe(1_000);

      clock = 5_000;
      graph.transitionFeature('f-1', { status: 'in_progress' });

      const after = db
        .prepare<[string], { created_at: number; updated_at: number }>(
          'SELECT created_at, updated_at FROM features WHERE id = ?',
        )
        .get('f-1');
      expect(after?.created_at).toBe(1_000);
      expect(after?.updated_at).toBe(5_000);
    });
  });

  describe('rollback on SQL failure', () => {
    it('restores inner state when the diff write throws', () => {
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      const snapshotBefore = graph.snapshot();

      // Close the db so any subsequent prepare/run inside a mutation throws.
      db.close();

      expect(() =>
        graph.createFeature({
          id: 'f-1',
          milestoneId: 'm-1',
          name: 'F',
          description: 'd',
        }),
      ).toThrow();

      // Inner state must be restored: no f-1.
      expect(graph.features.has('f-1')).toBe(false);
      expect(graph.milestones.get('m-1')?.name).toBe('M');

      // Snapshot should match the pre-mutation snapshot.
      const after = graph.snapshot();
      expect(after.features).toEqual(snapshotBefore.features);
      expect(after.milestones).toEqual(snapshotBefore.milestones);
    });
  });
});
