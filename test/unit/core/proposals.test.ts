import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  applyGraphProposal,
  collectProposalWarnings,
  GraphProposalBuilder,
  isGraphProposal,
  resolveProposalAlias,
} from '@core/proposals/index';
import { describe, expect, it } from 'vitest';

import { updateFeature } from '../../helpers/graph-builders.js';

function createGraph(): InMemoryFeatureGraph {
  const graph = new InMemoryFeatureGraph();
  graph.createMilestone({
    id: 'm-1',
    name: 'Milestone 1',
    description: 'desc',
  });
  return graph;
}

describe('GraphProposalBuilder', () => {
  it('retains op order and keeps aliases separate from canonical ids', () => {
    const builder = new GraphProposalBuilder('plan');

    const featureAlias = builder.allocateFeatureId('f-new');
    const taskAlias = builder.allocateTaskId('t-new');

    builder.addOp({
      kind: 'add_feature',
      featureId: 'f-new',
      milestoneId: 'm-1',
      name: 'New feature',
      description: 'draft',
    });
    builder.addOp({
      kind: 'add_task',
      taskId: 't-new',
      featureId: 'f-new',
      description: 'First task',
      weight: 'medium',
      reservedWritePaths: ['src/new.ts'],
    });

    const proposal = builder.build();

    expect(featureAlias).toBe('#1');
    expect(taskAlias).toBe('#2');
    expect(featureAlias).not.toBe('f-new');
    expect(taskAlias).not.toBe('t-new');
    expect(resolveProposalAlias(proposal, '#1')).toBe('f-new');
    expect(resolveProposalAlias(proposal, '#2')).toBe('t-new');
    expect(proposal.ops.map((op) => op.kind)).toEqual([
      'add_feature',
      'add_task',
    ]);
  });
});

describe('applyGraphProposal', () => {
  it('applies milestone creation ops', () => {
    const graph = createGraph();
    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'add_milestone',
      milestoneId: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(graph.milestones.get('m-2')).toEqual(
      expect.objectContaining({
        id: 'm-2',
        name: 'Milestone 2',
        description: 'second milestone',
      }),
    );
  });

  it('applies add_milestone before add_feature in same proposal', () => {
    const graph = createGraph();
    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'add_milestone',
      milestoneId: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    builder.addOp({
      kind: 'add_feature',
      featureId: 'f-1',
      milestoneId: 'm-2',
      name: 'Feature 1',
      description: 'desc',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied.map((op) => op.kind)).toEqual([
      'add_milestone',
      'add_feature',
    ]);
    expect(result.skipped).toHaveLength(0);
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        id: 'f-1',
        milestoneId: 'm-2',
        name: 'Feature 1',
      }),
    );
  });

  it('skips duplicate milestone ids as stale ops', () => {
    const graph = createGraph();
    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'add_milestone',
      milestoneId: 'm-1',
      name: 'Milestone 1 duplicate',
      description: 'dup',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('Milestone "m-1" already exists');
    expect(graph.milestones.get('m-1')).toEqual(
      expect.objectContaining({
        id: 'm-1',
        name: 'Milestone 1',
      }),
    );
  });

  it('skips stale ops in order and reports applied vs skipped results', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'edit_feature',
      featureId: 'f-1',
      patch: { name: 'Feature 1 updated' },
    });
    builder.addOp({
      kind: 'remove_task',
      taskId: 't-missing',
    });
    builder.addOp({
      kind: 'add_task',
      taskId: 't-1',
      featureId: 'f-1',
      description: 'Task 1',
    });
    builder.addOp({
      kind: 'add_dependency',
      fromId: 't-1',
      toId: 't-missing',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(graph.features.get('f-1')?.name).toBe('Feature 1 updated');
    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({ description: 'Task 1' }),
    );
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.opIndex).toBe(1);
    expect(result.skipped[0]?.reason).toContain('does not exist');
    expect(result.skipped[1]?.opIndex).toBe(3);
    expect(result.skipped[1]?.reason).toContain('does not exist');
    expect(result.summary).toContain('2 applied');
    expect(result.summary).toContain('2 skipped');
  });

  it('warns when removal touches started work and skips started task removal on approval', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'Task 1',
    });
    graph.transitionTask('t-1', {
      status: 'ready',
      collabControl: 'branch_open',
    });
    graph.transitionTask('t-1', { status: 'running' });

    const builder = new GraphProposalBuilder('replan');
    builder.addOp({ kind: 'remove_task', taskId: 't-1' });

    const proposal = builder.build();
    const warnings = collectProposalWarnings(graph, proposal);
    const result = applyGraphProposal(graph, proposal);

    expect(warnings).toEqual([
      expect.objectContaining({ code: 'remove_started_task', entityId: 't-1' }),
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.opIndex).toBe(0);
    expect(result.skipped[0]?.reason).toContain('already started');
    expect(graph.tasks.has('t-1')).toBe(true);
  });

  it('skips feature removal when downstream features still depend on it', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
      dependsOn: ['f-1'],
    });

    const builder = new GraphProposalBuilder('replan');
    builder.addOp({ kind: 'remove_feature', featureId: 'f-1' });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.opIndex).toBe(0);
    expect(result.skipped[0]?.reason).toContain('still has dependents');
    expect(graph.features.has('f-1')).toBe(true);
    expect(graph.features.get('f-2')?.dependsOn).toEqual(['f-1']);
  });

  it('skips started feature removal on approval', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    updateFeature(graph, 'f-1', {
      workControl: 'executing',
      status: 'in_progress',
      collabControl: 'branch_open',
    });

    const builder = new GraphProposalBuilder('replan');
    builder.addOp({ kind: 'remove_feature', featureId: 'f-1' });

    const proposal = builder.build();
    const warnings = collectProposalWarnings(graph, proposal);
    const result = applyGraphProposal(graph, proposal);

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'remove_started_feature',
        entityId: 'f-1',
      }),
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.opIndex).toBe(0);
    expect(result.skipped[0]?.reason).toContain('already has started work');
    expect(graph.features.has('f-1')).toBe(true);
  });

  it('validates full proposal payload shape before apply', () => {
    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: {},
        ops: [{ kind: 'drop_database' }],
      }),
    ).toBe(false);
  });

  it('rejects edit_feature patch with runtime-block field', () => {
    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: {},
        ops: [
          {
            kind: 'edit_feature',
            featureId: 'f-1',
            patch: { runtimeBlockedByFeatureId: 'f-2' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects edit_feature patch with unknown keys', () => {
    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: {},
        ops: [
          {
            kind: 'edit_feature',
            featureId: 'f-1',
            patch: { name: 'ok', bogus: 'x' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('does not apply runtime-block via edit_feature proposal', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
    });

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: {},
      ops: [
        {
          kind: 'edit_feature',
          featureId: 'f-1',
          patch: {
            name: 'renamed',
            runtimeBlockedByFeatureId: 'f-2',
          },
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    expect(() => applyGraphProposal(graph, proposal)).toThrow(
      /invalid proposal payload/,
    );
    expect(
      graph.features.get('f-1')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.features.get('f-1')?.name).toBe('Feature 1');
  });

  it('accepts valid proposal payload with reserved write paths', () => {
    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: { '#1': 't-1' },
        ops: [
          {
            kind: 'add_task',
            taskId: 't-1',
            featureId: 'f-1',
            description: 'Task 1',
            reservedWritePaths: ['src/a.ts', 'src/b.ts'],
          },
        ],
      }),
    ).toBe(true);
  });

  it('validates milestone op payload shape', () => {
    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: {},
        ops: [
          {
            kind: 'add_milestone',
            milestoneId: 'm-2',
            name: 'Milestone 2',
            description: 'second milestone',
          },
        ],
      }),
    ).toBe(true);

    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: {},
        ops: [
          {
            kind: 'add_milestone',
            milestoneId: 'm-2',
            name: 'Milestone 2',
          },
        ],
      }),
    ).toBe(false);
  });

  it('reuses alias for same canonical id', () => {
    const builder = new GraphProposalBuilder('replan');

    expect(builder.allocateFeatureId('f-1')).toBe('#1');
    expect(builder.allocateFeatureId('f-1')).toBe('#1');
    expect(builder.allocateTaskId('t-1')).toBe('#2');
    expect(builder.allocateTaskId('t-1')).toBe('#2');
  });

  it('applies add and remove dependency operations for features and tasks', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });

    const addFeatureDependency = new GraphProposalBuilder('plan');
    addFeatureDependency.addOp({
      kind: 'add_dependency',
      fromId: 'f-2',
      toId: 'f-1',
    });
    const addTaskDependency = new GraphProposalBuilder('plan');
    addTaskDependency.addOp({
      kind: 'add_dependency',
      fromId: 't-2',
      toId: 't-1',
    });

    expect(
      applyGraphProposal(graph, addFeatureDependency.build()).applied,
    ).toHaveLength(1);
    expect(
      applyGraphProposal(graph, addTaskDependency.build()).applied,
    ).toHaveLength(1);
    expect(graph.features.get('f-2')?.dependsOn).toEqual(['f-1']);
    expect(graph.tasks.get('t-2')?.dependsOn).toEqual(['t-1']);

    const removeFeatureDependency = new GraphProposalBuilder('replan');
    removeFeatureDependency.addOp({
      kind: 'remove_dependency',
      fromId: 'f-2',
      toId: 'f-1',
    });
    const removeTaskDependency = new GraphProposalBuilder('replan');
    removeTaskDependency.addOp({
      kind: 'remove_dependency',
      fromId: 't-2',
      toId: 't-1',
    });

    expect(
      applyGraphProposal(graph, removeFeatureDependency.build()).applied,
    ).toHaveLength(1);
    expect(
      applyGraphProposal(graph, removeTaskDependency.build()).applied,
    ).toHaveLength(1);
    expect(graph.features.get('f-2')?.dependsOn).toEqual([]);
    expect(graph.tasks.get('t-2')?.dependsOn).toEqual([]);
  });

  it('skips invalid dependency operations with exact reasons', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-2', description: 'Task 2' });

    const mixed = new GraphProposalBuilder('replan');
    mixed.addOp({ kind: 'add_dependency', fromId: 'f-1', toId: 't-1' });
    expect(applyGraphProposal(graph, mixed.build()).skipped[0]?.reason).toBe(
      'Dependency endpoints must both be features or both be tasks',
    );

    const crossFeatureTasks = new GraphProposalBuilder('replan');
    crossFeatureTasks.addOp({
      kind: 'add_dependency',
      fromId: 't-1',
      toId: 't-2',
    });
    expect(
      applyGraphProposal(graph, crossFeatureTasks.build()).skipped[0]?.reason,
    ).toBe('Task "t-1" and task "t-2" belong to different features');

    const removeMissing = new GraphProposalBuilder('replan');
    removeMissing.addOp({
      kind: 'remove_dependency',
      fromId: 'f-2',
      toId: 'f-1',
    });
    expect(
      applyGraphProposal(graph, removeMissing.build()).skipped[0]?.reason,
    ).toBe('Feature "f-2" does not depend on "f-1"');
  });

  it('warns when removing pending feature with started child task', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.transitionTask('t-1', {
      status: 'ready',
      collabControl: 'branch_open',
    });
    graph.transitionTask('t-1', { status: 'running' });

    const builder = new GraphProposalBuilder('replan');
    builder.addOp({ kind: 'remove_feature', featureId: 'f-1' });

    expect(collectProposalWarnings(graph, builder.build())).toEqual([
      expect.objectContaining({
        code: 'remove_started_feature',
        entityId: 'f-1',
        message: 'Feature "f-1" already has started work',
      }),
    ]);
  });

  it('appends newly added features and tasks after deleted siblings', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'desc',
    });
    graph.createFeature({
      id: 'f-3',
      milestoneId: 'm-1',
      name: 'Feature 3',
      description: 'desc',
    });
    graph.removeFeature('f-2');

    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    graph.createTask({ id: 't-3', featureId: 'f-1', description: 'Task 3' });
    graph.removeTask('t-2');

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'add_feature',
      featureId: 'f-4',
      milestoneId: 'm-1',
      name: 'Feature 4',
      description: 'desc',
    });
    builder.addOp({
      kind: 'add_task',
      taskId: 't-4',
      featureId: 'f-1',
      description: 'Task 4',
    });

    applyGraphProposal(graph, builder.build());

    expect(graph.features.get('f-4')?.orderInMilestone).toBe(3);
    expect(graph.tasks.get('t-4')?.orderInFeature).toBe(3);
  });
});
