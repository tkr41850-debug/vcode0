import { InMemoryFeatureGraph } from '@core/graph/index';
import {
  GraphProposalBuilder,
  applyGraphProposal,
  collectProposalWarnings,
  isGraphProposal,
  resolveProposalAlias,
} from '@core/proposals/index';
import { describe, expect, it } from 'vitest';

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
    expect(result.skipped).toEqual([
      expect.objectContaining({
        opIndex: 1,
        reason: expect.stringContaining('does not exist'),
      }),
      expect.objectContaining({
        opIndex: 3,
        reason: expect.stringContaining('does not exist'),
      }),
    ]);
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
    expect(result.skipped).toEqual([
      expect.objectContaining({
        opIndex: 0,
        reason: expect.stringContaining('already started'),
      }),
    ]);
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
    expect(result.skipped).toEqual([
      expect.objectContaining({
        opIndex: 0,
        reason: expect.stringContaining('still has dependents'),
      }),
    ]);
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
    graph.transitionFeature('f-1', {
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
    expect(result.skipped).toEqual([
      expect.objectContaining({
        opIndex: 0,
        reason: expect.stringContaining('already has started work'),
      }),
    ]);
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
