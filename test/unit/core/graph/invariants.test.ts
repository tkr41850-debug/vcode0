import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  assertChildOwnedOrder,
  assertFeatureDepsAreFeatureOnly,
  assertNoCycles,
  assertOneMilestonePerFeature,
  assertReferentialIntegrity,
  assertStatusConsistency,
  assertTaskDepsAreSameFeature,
  assertTypedIdNamespaces,
  GraphInvariantViolation,
} from '@core/graph/validation';
import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';
import { describe, expect, it } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────
//
// Each test builds a minimal-valid graph (milestone + 2 features + 2 tasks)
// then mutates it into an invariant-violating shape. We poke the Map
// directly rather than going through the mutation helpers because the goal
// is to exercise the `assert*` validators in isolation.

function buildValidGraph(): InMemoryFeatureGraph {
  const g = new InMemoryFeatureGraph();
  const m: Milestone = {
    id: 'm-1' as MilestoneId,
    name: 'M',
    description: '',
    status: 'pending',
    order: 0,
  };
  g.milestones.set(m.id, m);

  const f1: Feature = {
    id: 'f-1' as FeatureId,
    milestoneId: 'm-1' as MilestoneId,
    orderInMilestone: 0,
    name: 'Feature 1',
    description: '',
    dependsOn: [],
    status: 'pending',
    workControl: 'discussing',
    collabControl: 'none',
    featureBranch: 'feat-feature-1-1',
  };
  const f2: Feature = {
    id: 'f-2' as FeatureId,
    milestoneId: 'm-1' as MilestoneId,
    orderInMilestone: 1,
    name: 'Feature 2',
    description: '',
    dependsOn: ['f-1' as FeatureId],
    status: 'pending',
    workControl: 'discussing',
    collabControl: 'none',
    featureBranch: 'feat-feature-2-2',
  };
  g.features.set(f1.id, f1);
  g.features.set(f2.id, f2);

  const t1: Task = {
    id: 't-1' as TaskId,
    featureId: 'f-1' as FeatureId,
    orderInFeature: 0,
    description: 'T1',
    dependsOn: [],
    status: 'pending',
    collabControl: 'none',
  };
  const t2: Task = {
    id: 't-2' as TaskId,
    featureId: 'f-1' as FeatureId,
    orderInFeature: 1,
    description: 'T2',
    dependsOn: ['t-1' as TaskId],
    status: 'pending',
    collabControl: 'none',
  };
  g.tasks.set(t1.id, t1);
  g.tasks.set(t2.id, t2);

  return g;
}

// ── Invariant 1: no cycles ──────────────────────────────────────────────

describe('assertNoCycles', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertNoCycles(g)).not.toThrow();
  });

  it('throws on feature-dependency cycle', () => {
    const g = buildValidGraph();
    const f1 = g.features.get('f-1' as FeatureId);
    if (!f1) throw new Error('fixture broken');
    g.features.set(f1.id, { ...f1, dependsOn: ['f-2' as FeatureId] });
    expect(() => assertNoCycles(g)).toThrow(GraphInvariantViolation);
  });

  it('throws on task-dependency cycle within a feature', () => {
    const g = buildValidGraph();
    const t1 = g.tasks.get('t-1' as TaskId);
    if (!t1) throw new Error('fixture broken');
    g.tasks.set(t1.id, { ...t1, dependsOn: ['t-2' as TaskId] });
    expect(() => assertNoCycles(g)).toThrow(GraphInvariantViolation);
  });
});

// ── Invariant 2: feature deps are feature-only ──────────────────────────

describe('assertFeatureDepsAreFeatureOnly', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertFeatureDepsAreFeatureOnly(g)).not.toThrow();
  });

  it('throws when feature depends on non-feature id', () => {
    const g = buildValidGraph();
    const f2 = g.features.get('f-2' as FeatureId);
    if (!f2) throw new Error('fixture broken');
    // Cross-kind dependency: feature pointing to a milestone-shaped id.
    g.features.set(f2.id, {
      ...f2,
      dependsOn: ['m-1' as unknown as FeatureId],
    });
    expect(() => assertFeatureDepsAreFeatureOnly(g)).toThrow(
      GraphInvariantViolation,
    );
  });

  it('throws when feature depends on nonexistent feature', () => {
    const g = buildValidGraph();
    const f2 = g.features.get('f-2' as FeatureId);
    if (!f2) throw new Error('fixture broken');
    g.features.set(f2.id, { ...f2, dependsOn: ['f-missing' as FeatureId] });
    expect(() => assertFeatureDepsAreFeatureOnly(g)).toThrow(
      GraphInvariantViolation,
    );
  });
});

// ── Invariant 3: task deps are same-feature only ────────────────────────

describe('assertTaskDepsAreSameFeature', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertTaskDepsAreSameFeature(g)).not.toThrow();
  });

  it('throws on cross-feature task dependency', () => {
    const g = buildValidGraph();
    const t3: Task = {
      id: 't-3' as TaskId,
      featureId: 'f-2' as FeatureId,
      orderInFeature: 0,
      description: 'T3 in f-2',
      dependsOn: ['t-1' as TaskId], // t-1 belongs to f-1
      status: 'pending',
      collabControl: 'none',
    };
    g.tasks.set(t3.id, t3);
    expect(() => assertTaskDepsAreSameFeature(g)).toThrow(
      GraphInvariantViolation,
    );
  });

  it('throws on non-task dependency id', () => {
    const g = buildValidGraph();
    const t2 = g.tasks.get('t-2' as TaskId);
    if (!t2) throw new Error('fixture broken');
    g.tasks.set(t2.id, { ...t2, dependsOn: ['f-1' as unknown as TaskId] });
    expect(() => assertTaskDepsAreSameFeature(g)).toThrow(
      GraphInvariantViolation,
    );
  });
});

// ── Invariant 4: typed-ID namespaces ────────────────────────────────────

describe('assertTypedIdNamespaces', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertTypedIdNamespaces(g)).not.toThrow();
  });

  it('throws when milestone id lacks m- prefix', () => {
    const g = buildValidGraph();
    const m = g.milestones.get('m-1' as MilestoneId);
    if (!m) throw new Error('fixture broken');
    g.milestones.delete(m.id);
    g.milestones.set('bad' as MilestoneId, {
      ...m,
      id: 'bad' as MilestoneId,
    });
    expect(() => assertTypedIdNamespaces(g)).toThrow(GraphInvariantViolation);
  });

  it('throws when feature id lacks f- prefix', () => {
    const g = buildValidGraph();
    const f = g.features.get('f-1' as FeatureId);
    if (!f) throw new Error('fixture broken');
    g.features.delete(f.id);
    g.features.set('bad' as FeatureId, { ...f, id: 'bad' as FeatureId });
    expect(() => assertTypedIdNamespaces(g)).toThrow(GraphInvariantViolation);
  });

  it('throws when task id lacks t- prefix', () => {
    const g = buildValidGraph();
    const t = g.tasks.get('t-1' as TaskId);
    if (!t) throw new Error('fixture broken');
    g.tasks.delete(t.id);
    g.tasks.set('bad' as TaskId, { ...t, id: 'bad' as TaskId });
    expect(() => assertTypedIdNamespaces(g)).toThrow(GraphInvariantViolation);
  });
});

// ── Invariant 5: one milestone per feature ──────────────────────────────

describe('assertOneMilestonePerFeature', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertOneMilestonePerFeature(g)).not.toThrow();
  });

  it('throws when feature references nonexistent milestone', () => {
    const g = buildValidGraph();
    const f = g.features.get('f-1' as FeatureId);
    if (!f) throw new Error('fixture broken');
    g.features.set(f.id, {
      ...f,
      milestoneId: 'm-missing' as MilestoneId,
    });
    expect(() => assertOneMilestonePerFeature(g)).toThrow(
      GraphInvariantViolation,
    );
  });
});

// ── Invariant 6: child-owned sibling order ──────────────────────────────

describe('assertChildOwnedOrder', () => {
  it('passes on valid graph (unique orders per parent)', () => {
    const g = buildValidGraph();
    expect(() => assertChildOwnedOrder(g)).not.toThrow();
  });

  it('throws when two features in a milestone share orderInMilestone', () => {
    const g = buildValidGraph();
    const f2 = g.features.get('f-2' as FeatureId);
    if (!f2) throw new Error('fixture broken');
    g.features.set(f2.id, { ...f2, orderInMilestone: 0 });
    expect(() => assertChildOwnedOrder(g)).toThrow(GraphInvariantViolation);
  });

  it('throws when two tasks in a feature share orderInFeature', () => {
    const g = buildValidGraph();
    const t2 = g.tasks.get('t-2' as TaskId);
    if (!t2) throw new Error('fixture broken');
    g.tasks.set(t2.id, { ...t2, orderInFeature: 0 });
    expect(() => assertChildOwnedOrder(g)).toThrow(GraphInvariantViolation);
  });
});

// ── Invariant 7: referential integrity ──────────────────────────────────

describe('assertReferentialIntegrity', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertReferentialIntegrity(g)).not.toThrow();
  });

  it('throws when feature references nonexistent milestone', () => {
    const g = buildValidGraph();
    const f = g.features.get('f-1' as FeatureId);
    if (!f) throw new Error('fixture broken');
    g.features.set(f.id, {
      ...f,
      milestoneId: 'm-gone' as MilestoneId,
    });
    expect(() => assertReferentialIntegrity(g)).toThrow(
      GraphInvariantViolation,
    );
  });

  it('throws when task references nonexistent feature', () => {
    const g = buildValidGraph();
    const t = g.tasks.get('t-1' as TaskId);
    if (!t) throw new Error('fixture broken');
    g.tasks.set(t.id, { ...t, featureId: 'f-gone' as FeatureId });
    expect(() => assertReferentialIntegrity(g)).toThrow(
      GraphInvariantViolation,
    );
  });

  it('throws when feature has dangling feature dependency', () => {
    const g = buildValidGraph();
    const f2 = g.features.get('f-2' as FeatureId);
    if (!f2) throw new Error('fixture broken');
    g.features.set(f2.id, { ...f2, dependsOn: ['f-gone' as FeatureId] });
    expect(() => assertReferentialIntegrity(g)).toThrow(
      GraphInvariantViolation,
    );
  });

  it('throws when task has dangling task dependency', () => {
    const g = buildValidGraph();
    const t2 = g.tasks.get('t-2' as TaskId);
    if (!t2) throw new Error('fixture broken');
    g.tasks.set(t2.id, { ...t2, dependsOn: ['t-gone' as TaskId] });
    expect(() => assertReferentialIntegrity(g)).toThrow(
      GraphInvariantViolation,
    );
  });
});

// ── Invariant 8: status consistency ─────────────────────────────────────

describe('assertStatusConsistency', () => {
  it('passes on valid graph', () => {
    const g = buildValidGraph();
    expect(() => assertStatusConsistency(g)).not.toThrow();
  });

  it('throws when cancelled feature still has non-cancelled tasks', () => {
    const g = buildValidGraph();
    const f1 = g.features.get('f-1' as FeatureId);
    if (!f1) throw new Error('fixture broken');
    g.features.set(f1.id, {
      ...f1,
      collabControl: 'cancelled',
      status: 'cancelled',
    });
    // t-1 and t-2 still status=pending; should fail.
    expect(() => assertStatusConsistency(g)).toThrow(GraphInvariantViolation);
  });

  it('passes when cancelled feature has all-cancelled tasks', () => {
    const g = buildValidGraph();
    const f1 = g.features.get('f-1' as FeatureId);
    const t1 = g.tasks.get('t-1' as TaskId);
    const t2 = g.tasks.get('t-2' as TaskId);
    if (!f1 || !t1 || !t2) throw new Error('fixture broken');
    g.features.set(f1.id, {
      ...f1,
      collabControl: 'cancelled',
      status: 'cancelled',
    });
    g.tasks.set(t1.id, { ...t1, status: 'cancelled' });
    g.tasks.set(t2.id, { ...t2, status: 'cancelled' });
    expect(() => assertStatusConsistency(g)).not.toThrow();
  });
});

// ── GraphInvariantViolation is distinct from generic errors ─────────────

describe('GraphInvariantViolation', () => {
  it('is a proper Error subclass with stable name', () => {
    const err = new GraphInvariantViolation('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GraphInvariantViolation');
    expect(err.message).toBe('test');
  });
});
