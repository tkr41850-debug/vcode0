import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphSnapshot } from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import { SqliteStore } from '@persistence/sqlite';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

async function withTestStore(
  run: (store: SqliteStore) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'gvc0-integration-'));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await run(new SqliteStore());
  } finally {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('SqliteStore → Graph round-trip (integration)', () => {
  it('graph snapshot survives store save/load cycle', async () => {
    await withTestStore(async (store) => {
      // Build a graph in memory
      const original = new InMemoryFeatureGraph();
      original.createMilestone({
        id: 'm-1',
        name: 'MVP',
        description: 'Core features',
      });
      original.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Auth',
        description: 'Login system',
      });
      original.createFeature({
        id: 'f-2',
        milestoneId: 'm-1',
        name: 'Dashboard',
        description: 'User dashboard',
        dependsOn: ['f-1'],
      });
      original.createTask({
        id: 't-1',
        featureId: 'f-1',
        description: 'Implement login endpoint',
        weight: 'medium',
      });
      original.createTask({
        id: 't-2',
        featureId: 'f-1',
        description: 'Add session management',
        weight: 'small',
        dependsOn: ['t-1'],
      });
      original.createTask({
        id: 't-3',
        featureId: 'f-2',
        description: 'Build dashboard UI',
        weight: 'heavy',
      });

      const snap = original.snapshot();

      // Save to store
      await store.saveGraphState({
        milestones: snap.milestones,
        features: snap.features,
        tasks: snap.tasks,
      });

      // Load back via recovery
      const recovery = await store.loadRecoveryState();

      // Rebuild a graph from loaded data
      const rebuilt = new InMemoryFeatureGraph({
        milestones: recovery.milestones,
        features: recovery.features,
        tasks: recovery.tasks,
      });

      const rebuildSnap = rebuilt.snapshot();

      // Core structure survives
      expect(rebuildSnap.milestones).toHaveLength(snap.milestones.length);
      expect(rebuildSnap.features).toHaveLength(snap.features.length);
      expect(rebuildSnap.tasks).toHaveLength(snap.tasks.length);

      // Feature dependency edges survive
      const f2Rebuilt = rebuilt.features.get('f-2');
      expect(f2Rebuilt).toBeDefined();
      expect(f2Rebuilt!.dependsOn).toEqual(['f-1']);

      // Task dependency edges survive
      const t2Rebuilt = rebuilt.tasks.get('t-2');
      expect(t2Rebuilt).toBeDefined();
      expect(t2Rebuilt!.dependsOn).toEqual(['t-1']);

      // Task weights survive
      expect(rebuilt.tasks.get('t-1')!.weight).toBe('medium');
      expect(rebuilt.tasks.get('t-3')!.weight).toBe('heavy');
    });
  });

  it('store round-trip preserves readyTasks behavior', async () => {
    await withTestStore(async (store) => {
      // Use fixtures with pre-set state to avoid FSM transition issues
      const original = new InMemoryFeatureGraph({
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            featureBranch: 'feat-f-1',
            status: 'in_progress',
            workControl: 'executing',
          }),
        ],
        tasks: [
          createTaskFixture({
            id: 't-1',
            featureId: 'f-1',
            description: 'Root task',
            status: 'ready',
          }),
          createTaskFixture({
            id: 't-2',
            featureId: 'f-1',
            description: 'Dependent task',
            status: 'pending',
            dependsOn: ['t-1'],
          }),
        ],
      });

      const snap = original.snapshot();
      await store.saveGraphState({
        milestones: snap.milestones,
        features: snap.features,
        tasks: snap.tasks,
      });

      const recovery = await store.loadRecoveryState();
      const rebuilt = new InMemoryFeatureGraph({
        milestones: recovery.milestones,
        features: recovery.features,
        tasks: recovery.tasks,
      });

      // readyTasks should yield the same results as original
      const originalReady = original.readyTasks().map((t) => t.id);
      const rebuiltReady = rebuilt.readyTasks().map((t) => t.id);
      expect(rebuiltReady).toEqual(originalReady);
    });
  });

  it('dependency edges persist through store and load into graph', async () => {
    await withTestStore(async (store) => {
      // Save a graph with feature-level dependencies
      const snap: GraphSnapshot = {
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            featureBranch: 'feat-f-1',
            status: 'in_progress',
            workControl: 'executing',
          }),
          createFeatureFixture({
            id: 'f-2',
            milestoneId: 'm-1',
            featureBranch: 'feat-f-2',
            status: 'in_progress',
            workControl: 'executing',
            dependsOn: ['f-1'],
          }),
        ],
        tasks: [
          createTaskFixture({
            id: 't-1',
            featureId: 'f-1',
            status: 'ready',
          }),
          createTaskFixture({
            id: 't-2',
            featureId: 'f-2',
            status: 'ready',
          }),
        ],
      };

      await store.saveGraphState(snap);

      // Also persist explicit dependency edges
      await store.saveDependency({
        depType: 'feature',
        fromId: 'f-2',
        toId: 'f-1',
      });

      const recovery = await store.loadRecoveryState();

      // Feature dependsOn from the graph state
      const f2 = recovery.features.find((f) => f.id === 'f-2');
      expect(f2).toBeDefined();
      expect(f2!.dependsOn).toContain('f-1');

      // Explicit dependency edges from the dependency table
      expect(recovery.dependencies).toHaveLength(1);
      expect(recovery.dependencies[0]).toEqual({
        depType: 'feature',
        fromId: 'f-2',
        toId: 'f-1',
      });
    });
  });
});
