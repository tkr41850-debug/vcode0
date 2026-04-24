/**
 * Plan 04-03, Task 1 Part B — upstream feature-dep merged-gate matrix for
 * `readyTasks()`.
 *
 * These tests lock the invariant added to `src/core/graph/queries.ts`: a
 * downstream feature's tasks are only returned by `readyTasks()` when
 * every upstream `feature.dependsOn` entry has BOTH `workControl ===
 * 'work_complete'` AND `collabControl === 'merged'`. Every other collab
 * state — `none`, `branch_open`, `merge_queued`, `integrating`,
 * `conflict`, `cancelled` — blocks the downstream task from appearing in
 * the ready list.
 *
 * The fixture shape is intentionally minimal: a single milestone, an
 * upstream feature `f-up` with one done task `t-up-1`, and a downstream
 * feature `f-down` (which depends on `f-up`) holding one ready task
 * `t-down-1`. Each test flips the upstream feature's work/collab state
 * and re-queries `readyTasks()`.
 */

import type { InMemoryFeatureGraph } from '@core/graph/index';

import type {
  FeatureCollabControl,
  FeatureWorkControl,
} from '@core/types/index';
import { describe, expect, it } from 'vitest';
import {
  createGraphWithMilestone,
  updateFeature,
  updateTask,
} from '../../helpers/graph-builders.js';

function buildTwoFeatureChain(opts: {
  upstreamWork: FeatureWorkControl;
  upstreamCollab: FeatureCollabControl;
}): InMemoryFeatureGraph {
  const g = createGraphWithMilestone();
  g.createFeature({
    id: 'f-up',
    milestoneId: 'm-1',
    name: 'Up',
    description: 'upstream',
  });
  g.createFeature({
    id: 'f-down',
    milestoneId: 'm-1',
    name: 'Down',
    description: 'downstream',
    dependsOn: ['f-up'],
  });
  g.createTask({ id: 't-up-1', featureId: 'f-up', description: 'up task' });
  g.createTask({
    id: 't-down-1',
    featureId: 'f-down',
    description: 'down task',
  });
  updateTask(g, 't-up-1', { status: 'done' });
  updateTask(g, 't-down-1', { status: 'ready' });
  // Downstream must be in a task-driven execution state so its tasks are
  // not filtered by the other readyTasks guards. Upstream is flipped to
  // the test's target state.
  updateFeature(g, 'f-down', {
    workControl: 'executing',
    collabControl: 'branch_open',
  });
  updateFeature(g, 'f-up', {
    workControl: opts.upstreamWork,
    collabControl: opts.upstreamCollab,
  });
  return g;
}

describe('readyTasks — upstream feature-dep merged gate', () => {
  // Every non-`merged` collab state blocks downstream tasks. This
  // enumerates the full FeatureCollabControl union minus 'merged' plus
  // the work-complete-but-not-merged intermediate shape.
  const BLOCKING_STATES: Array<{
    work: FeatureWorkControl;
    collab: FeatureCollabControl;
    label: string;
  }> = [
    {
      work: 'executing',
      collab: 'branch_open',
      label: 'executing + branch_open',
    },
    {
      work: 'work_complete',
      collab: 'branch_open',
      label: 'work_complete + branch_open',
    },
    {
      work: 'work_complete',
      collab: 'merge_queued',
      label: 'work_complete + merge_queued',
    },
    {
      work: 'work_complete',
      collab: 'integrating',
      label: 'work_complete + integrating',
    },
    {
      work: 'work_complete',
      collab: 'conflict',
      label: 'work_complete + conflict',
    },
    {
      work: 'work_complete',
      collab: 'cancelled',
      label: 'work_complete + cancelled',
    },
    { work: 'work_complete', collab: 'none', label: 'work_complete + none' },
  ];

  for (const state of BLOCKING_STATES) {
    it(`blocks downstream tasks when upstream is ${state.label}`, () => {
      const g = buildTwoFeatureChain({
        upstreamWork: state.work,
        upstreamCollab: state.collab,
      });
      const tasks = g.readyTasks();
      expect(tasks.find((t) => t.id === 't-down-1')).toBeUndefined();
    });
  }

  it('unblocks downstream tasks when upstream transitions to work_complete + merged', () => {
    const g = buildTwoFeatureChain({
      upstreamWork: 'work_complete',
      upstreamCollab: 'branch_open',
    });
    expect(g.readyTasks().find((t) => t.id === 't-down-1')).toBeUndefined();

    updateFeature(g, 'f-up', { collabControl: 'merged' });

    expect(g.readyTasks().find((t) => t.id === 't-down-1')).toBeDefined();
  });

  it('does not affect features with no dependsOn', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-independent',
      milestoneId: 'm-1',
      name: 'Independent',
      description: 'no deps',
    });
    g.createTask({
      id: 't-1',
      featureId: 'f-independent',
      description: 'task',
    });
    updateTask(g, 't-1', { status: 'ready' });
    updateFeature(g, 'f-independent', {
      workControl: 'executing',
      collabControl: 'branch_open',
    });

    expect(g.readyTasks().find((t) => t.id === 't-1')).toBeDefined();
  });

  it('requires ALL upstream feature-deps to be merged (fan-in)', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'A',
      description: 'upstream A',
    });
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'B',
      description: 'upstream B',
    });
    g.createFeature({
      id: 'f-down',
      milestoneId: 'm-1',
      name: 'Down',
      description: 'fan-in downstream',
      dependsOn: ['f-a', 'f-b'],
    });
    g.createTask({ id: 't-1', featureId: 'f-down', description: 'task' });
    updateTask(g, 't-1', { status: 'ready' });
    updateFeature(g, 'f-a', {
      workControl: 'work_complete',
      collabControl: 'merged',
    });
    updateFeature(g, 'f-b', {
      workControl: 'work_complete',
      collabControl: 'branch_open',
    });
    updateFeature(g, 'f-down', {
      workControl: 'executing',
      collabControl: 'branch_open',
    });

    // f-b not merged → downstream blocked.
    expect(g.readyTasks().find((t) => t.id === 't-1')).toBeUndefined();

    updateFeature(g, 'f-b', { collabControl: 'merged' });

    expect(g.readyTasks().find((t) => t.id === 't-1')).toBeDefined();
  });

  it('work_complete alone is not enough — collab must also be merged', () => {
    // Guards against a plausible mis-read of the gate: "if upstream work
    // is complete, let downstream dispatch". The contract requires BOTH
    // workControl='work_complete' AND collabControl='merged'.
    const g = buildTwoFeatureChain({
      upstreamWork: 'work_complete',
      upstreamCollab: 'merge_queued',
    });
    expect(g.readyTasks().find((t) => t.id === 't-down-1')).toBeUndefined();

    updateFeature(g, 'f-up', { collabControl: 'merged' });
    expect(g.readyTasks().find((t) => t.id === 't-down-1')).toBeDefined();
  });
});
