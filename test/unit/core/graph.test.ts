import { GraphValidationError, InMemoryFeatureGraph } from '@core/graph/index';
import { describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createGraphFixture,
  createGraphWithFeature,
  createGraphWithMilestone,
  createGraphWithTask,
  createMilestoneFixture,
  createTaskFixture,
  updateFeature,
  updateTask,
} from '../../helpers/graph-builders.js';

describe('InMemoryFeatureGraph', () => {
  // ── Milestone creation ──────────────────────────────────────────────

  it('creates a milestone with valid options', () => {
    const g = createGraphFixture();
    const m = g.createMilestone({
      id: 'm-1',
      name: 'Milestone 1',
      description: 'First milestone',
    });
    expect(m.id).toBe('m-1');
    expect(m.name).toBe('Milestone 1');
    expect(m.status).toBe('pending');
    expect(m.order).toBe(0);
    expect(g.milestones.get('m-1')).toEqual(m);
  });

  it('rejects duplicate milestone id', () => {
    const g = createGraphFixture();
    g.createMilestone({ id: 'm-1', name: 'M1', description: 'd' });
    expect(() =>
      g.createMilestone({ id: 'm-1', name: 'M1b', description: 'd' }),
    ).toThrow(GraphValidationError);
  });

  it('rejects milestone with invalid id prefix', () => {
    const g = createGraphFixture();
    expect(() =>
      g.createMilestone({
        id: 'x-1' as `m-${string}`,
        name: 'Bad',
        description: 'd',
      }),
    ).toThrow(GraphValidationError);
  });

  it('assigns incremental order to milestones', () => {
    const g = createGraphFixture();
    const m1 = g.createMilestone({ id: 'm-1', name: 'A', description: 'd' });
    const m2 = g.createMilestone({ id: 'm-2', name: 'B', description: 'd' });
    expect(m1.order).toBe(0);
    expect(m2.order).toBe(1);
  });

  // ── Feature creation ────────────────────────────────────────────────

  it('creates a feature with no dependencies', () => {
    const g = createGraphWithMilestone();
    const f = g.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    expect(f.id).toBe('f-1');
    expect(f.milestoneId).toBe('m-1');
    expect(f.status).toBe('pending');
    expect(f.workControl).toBe('discussing');
    expect(f.collabControl).toBe('none');
    expect(f.featureBranch).toBe('feat-feature-1-1');
    expect(f.dependsOn).toEqual([]);
    expect(f.orderInMilestone).toBe(0);
    expect(g.features.get('f-1')).toEqual(f);
  });

  it('creates a feature with valid dependencies', () => {
    const g = createGraphWithFeature();
    const f2 = g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });
    expect(f2.dependsOn).toEqual(['f-1']);
  });

  it('rejects feature with nonexistent milestone', () => {
    const g = createGraphFixture();
    expect(() =>
      g.createFeature({
        id: 'f-1',
        milestoneId: 'm-999',
        name: 'F',
        description: 'd',
      }),
    ).toThrow(GraphValidationError);
  });

  it('rejects feature with nonexistent dependency', () => {
    const g = createGraphWithMilestone();
    expect(() =>
      g.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
        dependsOn: ['f-999'],
      }),
    ).toThrow(GraphValidationError);
  });

  it('rejects feature with self-dependency', () => {
    const g = createGraphWithMilestone();
    expect(() =>
      g.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
        dependsOn: ['f-1'],
      }),
    ).toThrow(GraphValidationError);
  });

  it('rejects feature dependency cycle (A→B→C→A) via snapshot hydration', () => {
    // createFeature can only produce self-dep cycles since new nodes have no
    // dependents yet. Multi-node cycles are validated through snapshot hydration.
    const snapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-a',
          dependsOn: ['f-c'],
          orderInMilestone: 0,
        }),
        createFeatureFixture({
          id: 'f-b',
          dependsOn: ['f-a'],
          orderInMilestone: 1,
        }),
        createFeatureFixture({
          id: 'f-c',
          dependsOn: ['f-b'],
          orderInMilestone: 2,
        }),
      ],
      tasks: [],
    };
    expect(() => new InMemoryFeatureGraph(snapshot)).toThrow(
      GraphValidationError,
    );
  });

  it('allows diamond dependencies without cycle error', () => {
    // f-a is root; f-b and f-c both depend on f-a; f-d depends on both f-b and f-c
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'A',
      description: 'd',
    });
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'B',
      description: 'd',
      dependsOn: ['f-a'],
    });
    g.createFeature({
      id: 'f-c',
      milestoneId: 'm-1',
      name: 'C',
      description: 'd',
      dependsOn: ['f-a'],
    });
    expect(() =>
      g.createFeature({
        id: 'f-d',
        milestoneId: 'm-1',
        name: 'D',
        description: 'd',
        dependsOn: ['f-b', 'f-c'],
      }),
    ).not.toThrow();
  });

  it('rejects duplicate feature id', () => {
    const g = createGraphWithFeature();
    expect(() =>
      g.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F1b',
        description: 'd',
      }),
    ).toThrow(GraphValidationError);
  });

  // ── Task creation ───────────────────────────────────────────────────

  it('creates a task with no dependencies', () => {
    const g = createGraphWithFeature();
    const t = g.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'Task 1',
    });
    expect(t.id).toBe('t-1');
    expect(t.featureId).toBe('f-1');
    expect(t.status).toBe('pending');
    expect(t.collabControl).toBe('none');
    expect(t.dependsOn).toEqual([]);
    expect(t.orderInFeature).toBe(0);
    expect(g.tasks.get('t-1')).toEqual(t);
  });

  it('creates a task with valid same-feature dependencies', () => {
    const g = createGraphWithTask();
    const t2 = g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
      dependsOn: ['t-1'],
    });
    expect(t2.dependsOn).toEqual(['t-1']);
    expect(t2.orderInFeature).toBe(1);
  });

  it('rejects task with cross-feature dependency', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
    });
    g.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
    expect(() =>
      g.createTask({
        id: 't-2',
        featureId: 'f-2',
        description: 'T2',
        dependsOn: ['t-1'],
      }),
    ).toThrow(GraphValidationError);
  });

  it('rejects task with nonexistent dependency', () => {
    const g = createGraphWithFeature();
    expect(() =>
      g.createTask({
        id: 't-1',
        featureId: 'f-1',
        description: 'T',
        dependsOn: ['t-999'],
      }),
    ).toThrow(GraphValidationError);
  });

  it('rejects task on cancelled feature', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { collabControl: 'cancelled' });
    expect(() =>
      g.createTask({ id: 't-1', featureId: 'f-1', description: 'T' }),
    ).toThrow(GraphValidationError);
  });

  it('rejects task on done feature (workControl=work_complete, collabControl=merged)', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', {
      workControl: 'work_complete',
      collabControl: 'merged',
    });
    expect(() =>
      g.createTask({ id: 't-1', featureId: 'f-1', description: 'T' }),
    ).toThrow(GraphValidationError);
  });

  it('rejects task with invalid id prefix', () => {
    const g = createGraphWithFeature();
    expect(() =>
      g.createTask({
        id: 'x-1' as `t-${string}`,
        featureId: 'f-1',
        description: 'T',
      }),
    ).toThrow(GraphValidationError);
  });

  // ── isComplete ──────────────────────────────────────────────────────

  it('isComplete returns false for empty graph', () => {
    const g = createGraphFixture();
    expect(g.isComplete()).toBe(false);
  });

  it('isComplete returns false with incomplete features', () => {
    const g = createGraphWithFeature();
    expect(g.isComplete()).toBe(false);
  });

  it('isComplete returns true when all features done', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', {
      workControl: 'work_complete',
      collabControl: 'merged',
    });
    expect(g.isComplete()).toBe(true);
  });

  // ── Milestone queue operations ──────────────────────────────────────

  it('queueMilestone / dequeueMilestone / clearQueuedMilestones / queuedMilestones behavior', () => {
    const g = createGraphFixture();
    g.createMilestone({ id: 'm-1', name: 'M1', description: 'd' });
    g.createMilestone({ id: 'm-2', name: 'M2', description: 'd' });
    g.createMilestone({ id: 'm-3', name: 'M3', description: 'd' });

    // Initially no queued milestones
    expect(g.queuedMilestones()).toEqual([]);

    // Queue m-2, then m-1
    g.queueMilestone('m-2');
    g.queueMilestone('m-1');
    const queued = g.queuedMilestones();
    expect(queued).toHaveLength(2);
    expect(queued[0]?.id).toBe('m-2');
    expect(queued[1]?.id).toBe('m-1');

    // Dequeue m-2
    g.dequeueMilestone('m-2');
    expect(g.queuedMilestones()).toHaveLength(1);
    expect(g.queuedMilestones()[0]?.id).toBe('m-1');

    // Queue m-3
    g.queueMilestone('m-3');
    expect(g.queuedMilestones()).toHaveLength(2);

    // Clear all
    g.clearQueuedMilestones();
    expect(g.queuedMilestones()).toEqual([]);
  });

  it('queueMilestone rejects nonexistent milestone', () => {
    const g = createGraphFixture();
    expect(() => g.queueMilestone('m-999')).toThrow(GraphValidationError);
  });

  it('dequeueMilestone rejects nonexistent milestone', () => {
    const g = createGraphFixture();
    expect(() => g.dequeueMilestone('m-999')).toThrow(GraphValidationError);
  });

  // ── Atomicity ───────────────────────────────────────────────────────

  it('graph state unchanged after rejected mutation', () => {
    const g = createGraphWithFeature();

    const featuresBefore = g.snapshot().features;

    // Attempt to create a feature with a nonexistent dependency — should fail
    expect(() =>
      g.createFeature({
        id: 'f-2',
        milestoneId: 'm-1',
        name: 'F2',
        description: 'd',
        dependsOn: ['f-999'],
      }),
    ).toThrow(GraphValidationError);

    // Graph should be unchanged
    expect(g.snapshot().features).toEqual(featuresBefore);
    expect(g.features.size).toBe(1);
  });

  // ── Snapshot hydration ──────────────────────────────────────────────

  it('snapshot hydration validates invariants and builds correct state', () => {
    const g1 = createGraphWithTask();

    const snap = g1.snapshot();
    const g2 = new InMemoryFeatureGraph(snap);

    expect(g2.milestones.size).toBe(1);
    expect(g2.features.size).toBe(1);
    expect(g2.tasks.size).toBe(1);
    expect(g2.milestones.get('m-1')?.name).toBe('M');
  });

  it('snapshot hydration rejects invalid state — dangling feature dep', () => {
    const snapshot = {
      milestones: [createMilestoneFixture()],
      features: [createFeatureFixture({ dependsOn: ['f-nonexistent'] })],
      tasks: [],
    };
    expect(() => new InMemoryFeatureGraph(snapshot)).toThrow(
      GraphValidationError,
    );
  });

  it('snapshot hydration rejects invalid state — dangling milestone ref', () => {
    const snapshot = {
      milestones: [],
      features: [createFeatureFixture({ milestoneId: 'm-missing' })],
      tasks: [],
    };
    expect(() => new InMemoryFeatureGraph(snapshot)).toThrow(
      GraphValidationError,
    );
  });

  it('snapshot hydration rejects invalid state — cross-feature task dep', () => {
    const snapshot = {
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({ id: 'f-1' }),
        createFeatureFixture({ id: 'f-2', orderInMilestone: 1 }),
      ],
      tasks: [
        createTaskFixture({ id: 't-1', featureId: 'f-1' }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          dependsOn: ['t-1'],
          orderInFeature: 0,
        }),
      ],
    };
    expect(() => new InMemoryFeatureGraph(snapshot)).toThrow(
      GraphValidationError,
    );
  });

  it('snapshot hydration rejects invalid id prefix', () => {
    const snapshot = {
      milestones: [createMilestoneFixture({ id: 'x-bad' as `m-${string}` })],
      features: [],
      tasks: [],
    };
    expect(() => new InMemoryFeatureGraph(snapshot)).toThrow(
      GraphValidationError,
    );
  });

  // ── addDependency ───────────────────────────────────────────────────

  it('addDependency adds a feature dependency', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
    });

    g.addDependency({ from: 'f-2', to: 'f-1' });

    const f2 = g.features.get('f-2');
    expect(f2?.dependsOn).toContain('f-1');
  });

  it('addDependency adds a task dependency', () => {
    const g = createGraphWithTask();
    g.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });

    g.addDependency({ from: 't-2', to: 't-1' });

    const t2 = g.tasks.get('t-2');
    expect(t2?.dependsOn).toContain('t-1');
  });

  it('addDependency rejects cycle in feature dependencies', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });

    // f-1 -> f-2 already exists, adding f-2 -> f-1 would create a cycle
    expect(() => g.addDependency({ from: 'f-1', to: 'f-2' })).toThrow(
      GraphValidationError,
    );
    // Graph unchanged
    expect(g.features.get('f-1')?.dependsOn).toEqual([]);
  });

  it('addDependency rejects cycle in task dependencies', () => {
    const g = createGraphWithTask();
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
      dependsOn: ['t-1'],
    });

    expect(() => g.addDependency({ from: 't-1', to: 't-2' })).toThrow(
      GraphValidationError,
    );
    expect(g.tasks.get('t-1')?.dependsOn).toEqual([]);
  });

  it('addDependency rejects cross-feature task dependency', () => {
    const g = createGraphWithTask();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
    });
    g.createTask({ id: 't-2', featureId: 'f-2', description: 'T2' });

    expect(() => g.addDependency({ from: 't-2', to: 't-1' })).toThrow(
      GraphValidationError,
    );
  });

  it('addDependency rejects nonexistent feature', () => {
    const g = createGraphWithFeature();

    expect(() => g.addDependency({ from: 'f-1', to: 'f-999' })).toThrow(
      GraphValidationError,
    );
  });

  it('addDependency rejects duplicate dependency', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });

    expect(() => g.addDependency({ from: 'f-2', to: 'f-1' })).toThrow(
      GraphValidationError,
    );
  });

  // ── removeDependency ───────────────────────────────────────────────

  it('removeDependency removes a feature dependency', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });

    g.removeDependency({ from: 'f-2', to: 'f-1' });

    expect(g.features.get('f-2')?.dependsOn).toEqual([]);
  });

  it('removeDependency removes a task dependency', () => {
    const g = createGraphWithTask();
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
      dependsOn: ['t-1'],
    });

    g.removeDependency({ from: 't-2', to: 't-1' });

    expect(g.tasks.get('t-2')?.dependsOn).toEqual([]);
  });

  it('removeDependency rejects nonexistent edge', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
    });

    expect(() => g.removeDependency({ from: 'f-2', to: 'f-1' })).toThrow(
      GraphValidationError,
    );
  });

  // ── readyFeatures ─────────────────────────────────────────────────

  it('readyFeatures returns features with no deps', () => {
    const g = createGraphWithFeature();

    const ready = g.readyFeatures();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('f-1');
  });

  it('readyFeatures excludes features with unsatisfied deps', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });

    const ready = g.readyFeatures();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('f-1');
  });

  it('readyFeatures includes feature once dep is done', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });

    // Mark f-1 as done
    updateFeature(g, 'f-1', {
      workControl: 'work_complete',
      collabControl: 'merged',
    });

    const ready = g.readyFeatures();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('f-2');
  });

  it('readyFeatures excludes cancelled features', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { collabControl: 'cancelled' });

    expect(g.readyFeatures()).toHaveLength(0);
  });

  it('readyFeatures excludes done features', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', {
      workControl: 'work_complete',
      collabControl: 'merged',
    });

    expect(g.readyFeatures()).toHaveLength(0);
  });

  // ── readyTasks ────────────────────────────────────────────────────

  it('readyTasks returns tasks with no deps in pending status', () => {
    const g = createGraphWithTask();

    const ready = g.readyTasks();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('t-1');
  });

  it('readyTasks excludes tasks with unsatisfied deps', () => {
    const g = createGraphWithTask();
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
      dependsOn: ['t-1'],
    });

    const ready = g.readyTasks();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('t-1');
  });

  it('readyTasks includes task once dep is done', () => {
    const g = createGraphWithTask();
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
      dependsOn: ['t-1'],
    });

    // Mark t-1 as done
    updateTask(g, 't-1', { status: 'done' });

    const ready = g.readyTasks();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('t-2');
  });

  it('readyTasks excludes tasks on cancelled feature', () => {
    const g = createGraphWithTask();
    updateFeature(g, 'f-1', { collabControl: 'cancelled' });

    expect(g.readyTasks()).toHaveLength(0);
  });

  it('readyTasks excludes tasks that are already running or done', () => {
    const g = createGraphWithTask();
    g.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });
    g.createTask({ id: 't-3', featureId: 'f-1', description: 'T3' });

    updateTask(g, 't-1', { status: 'running' });
    updateTask(g, 't-2', { status: 'done' });

    const ready = g.readyTasks();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe('t-3');
  });

  // ── cancelFeature ─────────────────────────────────────────────────

  it('cancelFeature cancels feature and its tasks', () => {
    const g = createGraphWithTask();
    g.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });

    g.cancelFeature('f-1');

    expect(g.features.get('f-1')?.collabControl).toBe('cancelled');
    expect(g.tasks.get('t-1')?.status).toBe('cancelled');
    expect(g.tasks.get('t-2')?.status).toBe('cancelled');
  });

  it('cancelFeature with cascade cancels transitive dependents', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });
    g.createFeature({
      id: 'f-3',
      milestoneId: 'm-1',
      name: 'F3',
      description: 'd',
      dependsOn: ['f-2'],
    });

    g.cancelFeature('f-1', true);

    expect(g.features.get('f-1')?.collabControl).toBe('cancelled');
    expect(g.features.get('f-2')?.collabControl).toBe('cancelled');
    expect(g.features.get('f-3')?.collabControl).toBe('cancelled');
  });

  it('cancelFeature without cascade does not cancel dependents', () => {
    const g = createGraphWithFeature();
    g.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'F2',
      description: 'd',
      dependsOn: ['f-1'],
    });

    g.cancelFeature('f-1');

    expect(g.features.get('f-1')?.collabControl).toBe('cancelled');
    expect(g.features.get('f-2')?.collabControl).toBe('none');
  });

  it('cancelFeature rejects nonexistent feature', () => {
    const g = createGraphFixture();
    expect(() => g.cancelFeature('f-999')).toThrow(GraphValidationError);
  });

  // ── changeMilestone ───────────────────────────────────────────────

  it('changeMilestone moves feature to another milestone', () => {
    const g = createGraphFixture();
    g.createMilestone({ id: 'm-1', name: 'M1', description: 'd' });
    g.createMilestone({ id: 'm-2', name: 'M2', description: 'd' });
    g.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'F1',
      description: 'd',
    });

    g.changeMilestone('f-1', 'm-2');

    expect(g.features.get('f-1')?.milestoneId).toBe('m-2');
  });

  it('changeMilestone rejects nonexistent milestone', () => {
    const g = createGraphWithFeature();

    expect(() => g.changeMilestone('f-1', 'm-999')).toThrow(
      GraphValidationError,
    );
  });

  // ── editFeature ───────────────────────────────────────────────────

  it('editFeature updates name and description', () => {
    const g = createGraphWithFeature({ name: 'Old', description: 'old desc' });

    const updated = g.editFeature('f-1', {
      name: 'New',
      description: 'new desc',
    });

    expect(updated.name).toBe('New');
    expect(updated.description).toBe('new desc');
    expect(g.features.get('f-1')?.name).toBe('New');
  });

  it('editFeature rejects editing cancelled feature', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { collabControl: 'cancelled' });

    expect(() => g.editFeature('f-1', { name: 'X' })).toThrow(
      GraphValidationError,
    );
  });

  // ── addTask (auto-ID) ────────────────────────────────────────────

  it('addTask generates incrementing task IDs', () => {
    const g = createGraphWithFeature();

    const t1 = g.addTask({ featureId: 'f-1', description: 'T1' });
    const t2 = g.addTask({ featureId: 'f-1', description: 'T2' });

    expect(t1.id).toMatch(/^t-/);
    expect(t2.id).toMatch(/^t-/);
    expect(t1.id).not.toBe(t2.id);
  });

  // ── removeTask ────────────────────────────────────────────────────

  it('removeTask removes a pending task', () => {
    const g = createGraphWithTask();

    g.removeTask('t-1');

    expect(g.tasks.has('t-1')).toBe(false);
  });

  it('removeTask rejects non-pending task', () => {
    const g = createGraphWithTask();
    updateTask(g, 't-1', { status: 'running' });

    expect(() => g.removeTask('t-1')).toThrow(GraphValidationError);
  });

  it('removeTask cleans up dependsOn references', () => {
    const g = createGraphWithTask();
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'T2',
      dependsOn: ['t-1'],
    });

    g.removeTask('t-1');

    expect(g.tasks.get('t-2')?.dependsOn).toEqual([]);
  });

  // ── reorderTasks ──────────────────────────────────────────────────

  it('reorderTasks updates orderInFeature', () => {
    const g = createGraphWithTask();
    g.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });
    g.createTask({ id: 't-3', featureId: 'f-1', description: 'T3' });

    g.reorderTasks('f-1', ['t-3', 't-1', 't-2']);

    expect(g.tasks.get('t-3')?.orderInFeature).toBe(0);
    expect(g.tasks.get('t-1')?.orderInFeature).toBe(1);
    expect(g.tasks.get('t-2')?.orderInFeature).toBe(2);
  });

  it('reorderTasks rejects incomplete task set', () => {
    const g = createGraphWithTask();
    g.createTask({ id: 't-2', featureId: 'f-1', description: 'T2' });

    expect(() => g.reorderTasks('f-1', ['t-1'])).toThrow(GraphValidationError);
  });

  // ── reweight ──────────────────────────────────────────────────────

  it('reweight updates task weight', () => {
    const g = createGraphWithTask();

    g.reweight('t-1', 'heavy');

    expect(g.tasks.get('t-1')?.weight).toBe('heavy');
  });

  it('reweight rejects nonexistent task', () => {
    const g = createGraphFixture();
    expect(() => g.reweight('t-999', 'small')).toThrow(GraphValidationError);
  });

  // ── FSM-validated transitions ─────────────────────────────────────

  it('transitionTask advances status pending to ready', () => {
    const g = createGraphWithTask();

    g.transitionTask('t-1', { status: 'ready' });
    expect(g.tasks.get('t-1')?.status).toBe('ready');
  });

  it('transitionTask rejects invalid status transition', () => {
    const g = createGraphWithTask();

    // pending -> done is not valid
    expect(() => g.transitionTask('t-1', { status: 'done' })).toThrow(
      GraphValidationError,
    );
  });

  it('transitionTask advances collabControl none to branch_open', () => {
    const g = createGraphWithTask();

    g.transitionTask('t-1', { collabControl: 'branch_open' });

    expect(g.tasks.get('t-1')?.collabControl).toBe('branch_open');
  });

  it('transitionTask completes task with done + merged + result', () => {
    const g = createGraphWithTask();
    updateTask(g, 't-1', { status: 'running', collabControl: 'branch_open' });

    g.transitionTask('t-1', {
      status: 'done',
      collabControl: 'merged',
      result: { summary: 'done', filesChanged: [] },
    });

    expect(g.tasks.get('t-1')?.status).toBe('done');
    expect(g.tasks.get('t-1')?.collabControl).toBe('merged');
    expect(g.tasks.get('t-1')?.result).toEqual({
      summary: 'done',
      filesChanged: [],
    });
  });

  it('transitionTask rejects completing a cancelled task', () => {
    const g = createGraphWithTask();
    updateTask(g, 't-1', { status: 'cancelled' });

    expect(() =>
      g.transitionTask('t-1', { status: 'done', collabControl: 'merged' }),
    ).toThrow(GraphValidationError);
  });

  it('transitionTask suspends a running task with reason and files', () => {
    const g = createGraphWithTask();
    updateTask(g, 't-1', {
      status: 'running',
      collabControl: 'branch_open',
    });

    g.transitionTask('t-1', {
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedAt: 1000,
      suspendedFiles: ['file.ts'],
    });

    expect(g.tasks.get('t-1')?.collabControl).toBe('suspended');
    expect(g.tasks.get('t-1')?.suspendReason).toBe('same_feature_overlap');
    expect(g.tasks.get('t-1')?.suspendedAt).toBe(1000);
    expect(g.tasks.get('t-1')?.suspendedFiles).toEqual(['file.ts']);
  });

  it('transitionTask rejects suspending a non-running task', () => {
    const g = createGraphWithTask();
    updateTask(g, 't-1', { collabControl: 'branch_open' });

    expect(() =>
      g.transitionTask('t-1', { collabControl: 'suspended' }),
    ).toThrow(GraphValidationError);
  });

  it('transitionTask resumes and clears suspend fields', () => {
    const g = createGraphWithTask();
    updateTask(g, 't-1', {
      status: 'running',
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedAt: 1000,
      suspendedFiles: ['file.ts'],
    });

    g.transitionTask('t-1', { collabControl: 'branch_open' });

    expect(g.tasks.get('t-1')?.collabControl).toBe('branch_open');
    expect(g.tasks.get('t-1')?.suspendReason).toBeUndefined();
    expect(g.tasks.get('t-1')?.suspendedAt).toBeUndefined();
    expect(g.tasks.get('t-1')?.suspendedFiles).toBeUndefined();
  });

  it('transitionFeature advances discussing to researching', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { status: 'done', collabControl: 'branch_open' });

    g.transitionFeature('f-1', {
      workControl: 'researching',
      status: 'pending',
    });

    expect(g.features.get('f-1')?.workControl).toBe('researching');
    expect(g.features.get('f-1')?.status).toBe('pending');
  });

  it('transitionFeature rejects invalid work transition', () => {
    const g = createGraphWithFeature();

    // discussing -> feature_ci is invalid (requires status=done for advance)
    expect(() =>
      g.transitionFeature('f-1', {
        workControl: 'feature_ci',
        status: 'pending',
      }),
    ).toThrow(GraphValidationError);
  });

  it('transitionFeature blocks when collabControl is cancelled', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', {
      workControl: 'executing',
      collabControl: 'cancelled',
    });

    expect(() =>
      g.transitionFeature('f-1', {
        workControl: 'feature_ci',
        status: 'pending',
      }),
    ).toThrow(GraphValidationError);
  });

  it('transitionFeature advances collabControl none to branch_open', () => {
    const g = createGraphWithFeature();

    g.transitionFeature('f-1', { collabControl: 'branch_open' });

    expect(g.features.get('f-1')?.collabControl).toBe('branch_open');
  });

  it('transitionFeature rejects merge_queued unless workControl is awaiting_merge', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { collabControl: 'branch_open' });

    // workControl is still 'discussing', not 'awaiting_merge'
    expect(() =>
      g.transitionFeature('f-1', { collabControl: 'merge_queued' }),
    ).toThrow(GraphValidationError);
  });

  it('transitionFeature enforces status reset on phase advance', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { status: 'done', collabControl: 'branch_open' });

    // Phase advance without resetting status to pending should fail
    expect(() =>
      g.transitionFeature('f-1', {
        workControl: 'researching',
        status: 'done',
      }),
    ).toThrow(GraphValidationError);
  });
});
