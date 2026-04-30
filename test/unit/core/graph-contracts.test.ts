import { GraphValidationError, InMemoryFeatureGraph } from '@core/graph/index';
import { describe, expect, it } from 'vitest';
import {
  createGraphFixture,
  createGraphWithFeature,
  createGraphWithMilestone,
  createGraphWithTask,
} from '../../helpers/graph-builders.js';

describe('FeatureGraph contracts', () => {
  it('snapshot reflects current authoritative graph state', () => {
    const g = createGraphFixture();

    // Create 1 milestone
    const m1 = g.createMilestone({
      id: 'm-1',
      name: 'Milestone 1',
      description: 'desc',
    });

    // Create 2 features in this milestone
    const f1 = g.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    const f2 = g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
      dependsOn: ['f-1'],
    });

    // Create 2 tasks in first feature
    const t1 = g.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'Task 1',
    });

    const t2 = g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'Task 2',
      dependsOn: ['t-1'],
    });

    // Get snapshot
    const snapshot = g.snapshot();

    // Verify counts match
    expect(snapshot.milestones).toHaveLength(1);
    expect(snapshot.features).toHaveLength(2);
    expect(snapshot.tasks).toHaveLength(2);

    // Verify milestone in snapshot
    expect(snapshot.milestones[0]).toEqual(m1);

    // Verify features in snapshot
    expect(snapshot.features).toContainEqual(f1);
    expect(snapshot.features).toContainEqual(f2);

    // Verify tasks in snapshot
    expect(snapshot.tasks).toContainEqual(t1);
    expect(snapshot.tasks).toContainEqual(t2);

    // Verify feature dependency is represented in snapshot
    const f2InSnapshot = snapshot.features.find((f) => f.id === 'f-2');
    expect(f2InSnapshot?.dependsOn).toContain('f-1');

    // Verify task dependency is represented in snapshot
    const t2InSnapshot = snapshot.tasks.find((t) => t.id === 't-2');
    expect(t2InSnapshot?.dependsOn).toContain('t-1');
  });

  it('rejected mutation leaves graph unchanged', () => {
    const g = createGraphWithFeature();

    // Snapshot current state
    const snapshotBefore = g.snapshot();

    // Attempt to create a feature with a dependency on non-existent feature
    expect(() => {
      g.createFeature({
        id: 'f-2',
        milestoneId: 'm-1',
        name: 'Feature 2',
        description: 'desc',
        dependsOn: ['f-nonexistent' as `f-${string}`],
      });
    }).toThrow(GraphValidationError);

    // Snapshot after failed mutation
    const snapshotAfter = g.snapshot();

    // Graph should be unchanged: still 1 feature
    expect(snapshotAfter.features).toHaveLength(1);
    const firstFeature = snapshotAfter.features[0];
    if (firstFeature) {
      expect(firstFeature.id).toBe('f-1');
    }

    // Verify snapshots match
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it('readyFeatures returns only features with satisfied deps', () => {
    const g = createGraphWithMilestone();

    // Create f-1 with no deps
    g.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    // Create f-2 that depends on f-1
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
      dependsOn: ['f-1'],
    });

    const ready = g.readyFeatures();

    // f-1 should be ready (no dependencies)
    expect(ready).toContainEqual(expect.objectContaining({ id: 'f-1' }));

    // f-2 should NOT be ready (depends on f-1 which is not complete)
    expect(ready).not.toContainEqual(expect.objectContaining({ id: 'f-2' }));
  });

  it('readyTasks returns only tasks with satisfied deps in non-cancelled feature', () => {
    const g = createGraphWithTask();

    // Update t-1 to have status=ready so it shows in readyTasks
    const t1 = g.tasks.get('t-1');
    if (t1) {
      g.tasks.set('t-1', { ...t1, status: 'ready' });
    }

    // Create t-2 that depends on t-1
    const t2 = g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'Task 2',
      dependsOn: ['t-1'],
    });

    // Update t-2 to have status=ready so it's evaluated by readyTasks
    g.tasks.set('t-2', { ...t2, status: 'ready' });

    const ready = g.readyTasks();

    // t-1 should be ready (status=ready, no dependencies)
    expect(ready).toContainEqual(expect.objectContaining({ id: 't-1' }));

    // t-2 should NOT be ready (depends on t-1 which is not complete)
    expect(ready).not.toContainEqual(expect.objectContaining({ id: 't-2' }));
  });

  it('milestone-as-dep-endpoint rejected', () => {
    const g = createGraphWithMilestone();

    // Try to create feature with milestone as dependency - should reject
    expect(() => {
      g.createFeature({
        id: 'f-1' as `f-${string}`,
        milestoneId: 'm-1',
        name: 'Feature 1',
        description: 'desc',
        dependsOn: ['m-1' as `f-${string}`],
      });
    }).toThrow(GraphValidationError);

    expect(() => {
      g.createFeature({
        id: 'f-1' as `f-${string}`,
        milestoneId: 'm-1',
        name: 'Feature 1',
        description: 'desc',
        dependsOn: ['m-1' as `f-${string}`],
      });
    }).toThrow(/must start with "f-"/);

    // Create a feature so we can test task milestone dependency
    g.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    // Try to create task with milestone as dependency - should reject
    expect(() => {
      g.createTask({
        id: 't-1' as `t-${string}`,
        featureId: 'f-1',
        description: 'Task 1',
        dependsOn: ['m-1' as `t-${string}`],
      });
    }).toThrow(GraphValidationError);

    expect(() => {
      g.createTask({
        id: 't-1' as `t-${string}`,
        featureId: 'f-1',
        description: 'Task 1',
        dependsOn: ['m-1' as `t-${string}`],
      });
    }).toThrow(/must start with "t-"/);
  });

  it('single-milestone-per-feature constraint', () => {
    const g = new InMemoryFeatureGraph();
    g.__enterTick();

    // Try to create feature without specifying milestoneId
    expect(() => {
      g.createFeature({
        id: 'f-1',
        milestoneId: 'm-nonexistent',
        name: 'Feature 1',
        description: 'desc',
      });
    }).toThrow(GraphValidationError);

    expect(() => {
      g.createFeature({
        id: 'f-1',
        milestoneId: 'm-nonexistent',
        name: 'Feature 1',
        description: 'desc',
      });
    }).toThrow(/does not exist/);

    // Create a valid milestone
    g.createMilestone({
      id: 'm-1',
      name: 'Milestone 1',
      description: 'desc',
    });

    // Now create a feature with the valid milestone should succeed
    const f = g.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    // Verify the feature belongs to exactly one milestone
    expect(f.milestoneId).toBe('m-1');
  });
});
