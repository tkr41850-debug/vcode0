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
    expect(result.skipped[0]?.reason).toContain('already exists');
    expect(graph.milestones.get('m-1')).toEqual(
      expect.objectContaining({
        id: 'm-1',
        name: 'Milestone 1',
      }),
    );
  });

  it('applies milestone edit and remove ops', () => {
    const graph = createGraph();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'edit_milestone',
      milestoneId: 'm-1',
      patch: { description: 'updated description' },
    });
    builder.addOp({ kind: 'remove_milestone', milestoneId: 'm-2' });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied.map((op) => op.kind)).toEqual([
      'edit_milestone',
      'remove_milestone',
    ]);
    expect(graph.milestones.get('m-1')).toEqual(
      expect.objectContaining({ description: 'updated description' }),
    );
    expect(graph.milestones.has('m-2')).toBe(false);
  });

  it('applies move_feature op', () => {
    const graph = createGraph();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'move_feature',
      featureId: 'f-1',
      milestoneId: 'm-2',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(1);
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({ milestoneId: 'm-2' }),
    );
  });

  it('applies split_feature with alias resolution for new feature ids', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-api', '#2': 'f-ui' },
      ops: [
        {
          kind: 'split_feature',
          featureId: 'f-1',
          splits: [
            { id: '#1', name: 'API feature', description: 'api work' },
            {
              id: '#2',
              name: 'UI feature',
              description: 'ui work',
              deps: ['#1'],
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toHaveLength(1);
    expect(result.resolvedAliases['#1']).toBe('f-2');
    expect(result.resolvedAliases['#2']).toBe('f-3');
    expect(graph.features.has('f-1')).toBe(false);
    expect(graph.features.get('f-2')).toEqual(
      expect.objectContaining({ name: 'API feature', dependsOn: [] }),
    );
    expect(graph.features.get('f-3')).toEqual(
      expect.objectContaining({ name: 'UI feature', dependsOn: ['f-2'] }),
    );
  });

  it('applies merge_features and rewrites dependents to retained feature', () => {
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
      dependsOn: ['f-2'],
    });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'merge_features',
      featureIds: ['f-1', 'f-2'],
      name: 'Merged feature',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(1);
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({ name: 'Merged feature' }),
    );
    expect(graph.features.has('f-2')).toBe(false);
    expect(graph.features.get('f-3')?.dependsOn).toEqual(['f-1']);
  });

  it('applies reorder_tasks op', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'reorder_tasks',
      featureId: 'f-1',
      taskIds: ['t-2', 't-1'],
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(1);
    expect(graph.tasks.get('t-2')?.orderInFeature).toBe(0);
    expect(graph.tasks.get('t-1')?.orderInFeature).toBe(1);
  });

  it('skips move_feature when additive-only approval touches live work', () => {
    const graph = createGraph();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    updateFeature(graph, 'f-1', {
      workControl: 'executing',
      status: 'pending',
      collabControl: 'branch_open',
    });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'move_feature',
      featureId: 'f-1',
      milestoneId: 'm-2',
    });

    const proposal = builder.build();
    const warnings = collectProposalWarnings(graph, proposal, {
      additiveOnly: true,
    });
    const result = applyGraphProposal(graph, proposal, { additiveOnly: true });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'move_started_feature',
        entityId: 'f-1',
        message: 'Feature "f-1" already has started work',
      }),
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        opIndex: 0,
        reason: 'Feature "f-1" already has started work',
      }),
    ]);
    expect(graph.features.get('f-1')?.milestoneId).toBe('m-1');
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

  it('warns and skips reorder_tasks when additive-only approval touches live task work', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    graph.transitionTask('t-1', {
      status: 'ready',
      collabControl: 'branch_open',
    });

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'reorder_tasks',
      featureId: 'f-1',
      taskIds: ['t-2', 't-1'],
    });

    const proposal = builder.build();
    const warnings = collectProposalWarnings(graph, proposal, {
      additiveOnly: true,
    });
    const result = applyGraphProposal(graph, proposal, { additiveOnly: true });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'reorder_started_task',
        entityId: 't-1',
        message: 'Task "t-1" already has started work',
      }),
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        opIndex: 0,
        reason: 'Task "t-1" already has started work',
      }),
    ]);
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
    expect(result.skipped[0]?.reason).toContain('cancel the task first');
    expect(graph.tasks.has('t-1')).toBe(true);
  });

  it('applies remove_task for a cancelled task without warnings', () => {
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
    graph.transitionTask('t-1', { status: 'cancelled' });

    const builder = new GraphProposalBuilder('replan');
    builder.addOp({ kind: 'remove_task', taskId: 't-1' });

    const proposal = builder.build();
    const warnings = collectProposalWarnings(graph, proposal);
    const result = applyGraphProposal(graph, proposal);

    expect(warnings).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(graph.tasks.has('t-1')).toBe(false);
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

  it('validates reorder_tasks payload shape', () => {
    expect(
      isGraphProposal({
        version: 1,
        mode: 'plan',
        aliases: {},
        ops: [
          {
            kind: 'reorder_tasks',
            featureId: 'f-1',
            taskIds: ['t-2', 't-1'],
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
            kind: 'reorder_tasks',
            featureId: 'f-1',
            taskIds: [],
          },
        ],
      }),
    ).toBe(false);
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

describe('applyGraphProposal — apply-time alias resolution', () => {
  it('resolves add_feature alias into fresh concrete id and rewrites dependent ops', () => {
    const graph = createGraph();

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-new', '#2': 't-new' },
      ops: [
        {
          kind: 'add_feature',
          featureId: '#1',
          milestoneId: 'm-1',
          name: 'Feature new',
          description: 'desc',
        },
        {
          kind: 'add_task',
          taskId: '#2',
          featureId: '#1',
          description: 'Task new',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.resolvedAliases?.['#1']).toBe('f-1');
    expect(result.resolvedAliases?.['#2']).toBe('t-1');
    expect(graph.features.get('f-1')?.name).toBe('Feature new');
    expect(graph.tasks.get('t-1')?.featureId).toBe('f-1');
  });

  it('allocates fresh ids past existing concrete ids in authoritative graph', () => {
    const graph = createGraph();
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-draft' },
      ops: [
        {
          kind: 'add_feature',
          featureId: '#1',
          milestoneId: 'm-1',
          name: 'Feature new',
          description: 'desc',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const result = applyGraphProposal(graph, proposal);

    expect(result.resolvedAliases?.['#1']).toBe('f-2');
    expect(graph.features.get('f-2')?.name).toBe('Feature new');
  });

  it('resolves add_dependency alias endpoints after fresh allocation', () => {
    const graph = createGraph();

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-a', '#2': 'f-b' },
      ops: [
        {
          kind: 'add_feature',
          featureId: '#1',
          milestoneId: 'm-1',
          name: 'A',
          description: 'a',
        },
        {
          kind: 'add_feature',
          featureId: '#2',
          milestoneId: 'm-1',
          name: 'B',
          description: 'b',
        },
        {
          kind: 'add_dependency',
          fromId: '#2',
          toId: '#1',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toHaveLength(3);
    expect(result.resolvedAliases?.['#1']).toBe('f-1');
    expect(result.resolvedAliases?.['#2']).toBe('f-2');
    expect(graph.features.get('f-2')?.dependsOn).toEqual(['f-1']);
  });

  it('allocates non-colliding real ids across two sequentially-applied proposals', () => {
    const graph = createGraph();

    const first = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-draft' },
      ops: [
        {
          kind: 'add_feature',
          featureId: '#1',
          milestoneId: 'm-1',
          name: 'Feature first',
          description: 'desc',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const second = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-draft' },
      ops: [
        {
          kind: 'add_feature',
          featureId: '#1',
          milestoneId: 'm-1',
          name: 'Feature second',
          description: 'desc',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const firstResult = applyGraphProposal(graph, first);
    const secondResult = applyGraphProposal(graph, second);

    expect(firstResult.resolvedAliases?.['#1']).toBe('f-1');
    expect(secondResult.resolvedAliases?.['#1']).toBe('f-2');
    expect(graph.features.get('f-1')?.name).toBe('Feature first');
    expect(graph.features.get('f-2')?.name).toBe('Feature second');
  });

  it('cascades skip to dependent ops when parent alias op is skipped', () => {
    const graph = createGraph();

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'f-new', '#2': 't-new' },
      ops: [
        {
          kind: 'add_feature',
          featureId: '#1',
          milestoneId: 'm-missing',
          name: 'Feature new',
          description: 'desc',
        },
        {
          kind: 'add_task',
          taskId: '#2',
          featureId: '#1',
          description: 'Task new',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const result = applyGraphProposal(graph, proposal);

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[1]?.reason).toContain('does not exist');
    expect(result.resolvedAliases?.['#1']).toBeUndefined();
    expect(result.resolvedAliases?.['#2']).toBeUndefined();
  });

  it('passes through legacy proposals without aliases', () => {
    const graph = createGraph();

    const builder = new GraphProposalBuilder('plan');
    builder.addOp({
      kind: 'add_feature',
      featureId: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });

    const result = applyGraphProposal(graph, builder.build());

    expect(result.applied).toHaveLength(1);
    expect(result.resolvedAliases ?? {}).toEqual({});
    expect(graph.features.get('f-1')?.name).toBe('Feature 1');
  });

  it('exposes resolvedAliases on result for add_milestone alias', () => {
    const graph = createGraph();

    const proposal = {
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'm-draft' },
      ops: [
        {
          kind: 'add_milestone',
          milestoneId: '#1',
          name: 'Milestone new',
          description: 'd',
        },
      ],
    } as unknown as Parameters<typeof applyGraphProposal>[1];

    const result = applyGraphProposal(graph, proposal);

    expect(result.resolvedAliases?.['#1']).toBe('m-2');
    expect(graph.milestones.get('m-2')?.name).toBe('Milestone new');
  });
});
