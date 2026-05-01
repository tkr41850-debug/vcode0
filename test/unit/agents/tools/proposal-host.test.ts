import { createProposalToolHost } from '@agents/tools';
import { applyGraphProposal } from '@core/proposals/index';
import type { ProposalPhaseDetails } from '@core/types/index';
import { describe, expect, it } from 'vitest';

import {
  createGraphWithFeature,
  createGraphWithMilestone,
} from '../../../helpers/graph-builders.js';

const proposalDetails: ProposalPhaseDetails = {
  summary: 'Plan ready.',
  chosenApproach: 'Reuse existing prompt registry and proposal host.',
  keyConstraints: ['Keep approval payload as raw proposal JSON'],
  decompositionRationale: [
    'Split prompt/runtime contract fixes from execution',
  ],
  orderingRationale: [
    'Make prompt contract truthful before downstream verify uses it',
  ],
  verificationExpectations: ['Run prompt tests and runtime tests'],
  risksTradeoffs: ['More structured payload means broader test updates'],
  assumptions: ['Proposal apply path still reads payloadJson'],
};

describe('GraphProposalToolHost', () => {
  it('stages milestone creation on draft graph only', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    const milestone = host.addMilestone({
      name: 'Milestone 2',
      description: 'second milestone',
    });

    expect(milestone).toMatchObject({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    expect(host.draft.milestones.get('m-2')).toMatchObject({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    expect(graph.milestones.has('m-2')).toBe(false);

    host.submit(proposalDetails);

    expect(host.buildProposal()).toEqual({
      version: 1,
      mode: 'plan',
      aliases: { '#1': 'm-2' },
      ops: [
        {
          kind: 'add_milestone',
          milestoneId: '#1',
          name: 'Milestone 2',
          description: 'second milestone',
        },
      ],
    });
  });

  it('edits milestones on the draft graph and records only changed fields', () => {
    const graph = createGraphWithMilestone();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'before',
    });
    const host = createProposalToolHost(graph, 'plan');

    const milestone = host.editMilestone({
      milestoneId: 'm-2',
      patch: { name: 'Milestone 2', description: 'after' },
    });

    expect(milestone).toMatchObject({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'after',
    });
    expect(host.draft.milestones.get('m-2')).toMatchObject({
      description: 'after',
    });
    expect(graph.milestones.get('m-2')?.description).toBe('before');

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toContainEqual({
      kind: 'edit_milestone',
      milestoneId: 'm-2',
      patch: { description: 'after' },
    });
  });

  it('removes milestones from the draft graph only', () => {
    const graph = createGraphWithMilestone();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    const host = createProposalToolHost(graph, 'plan');

    host.removeMilestone({ milestoneId: 'm-2' });

    expect(host.draft.milestones.has('m-2')).toBe(false);
    expect(graph.milestones.has('m-2')).toBe(true);

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toContainEqual({
      kind: 'remove_milestone',
      milestoneId: 'm-2',
    });
  });

  it('moves features on the draft graph only', () => {
    const graph = createGraphWithFeature();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    const host = createProposalToolHost(graph, 'plan');

    const feature = host.moveFeature({ featureId: 'f-1', milestoneId: 'm-2' });

    expect(feature).toMatchObject({ id: 'f-1', milestoneId: 'm-2' });
    expect(host.draft.features.get('f-1')?.milestoneId).toBe('m-2');
    expect(graph.features.get('f-1')?.milestoneId).toBe('m-1');

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toContainEqual({
      kind: 'move_feature',
      featureId: 'f-1',
      milestoneId: 'm-2',
    });
  });

  it('splits features on the draft graph and aliases new split ids', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    const features = host.splitFeature({
      featureId: 'f-1',
      splits: [
        { id: 'f-2', name: 'API feature', description: 'api work' },
        {
          id: 'f-3',
          name: 'UI feature',
          description: 'ui work',
          deps: ['f-2'],
        },
      ],
    });

    expect(features.map((feature) => feature.id)).toEqual(['f-2', 'f-3']);
    expect(host.draft.features.has('f-1')).toBe(false);
    expect(host.draft.features.get('f-3')?.dependsOn).toEqual(['f-2']);
    expect(graph.features.has('f-1')).toBe(true);

    host.submit(proposalDetails);
    const proposal = host.buildProposal();
    expect(proposal.aliases).toEqual({ '#1': 'f-2', '#2': 'f-3' });
    expect(proposal.ops).toContainEqual({
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
    });
  });

  it('merges features on the draft graph only', () => {
    const graph = createGraphWithFeature();
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Feature 2',
      description: 'second feature',
    });
    const host = createProposalToolHost(graph, 'plan');

    const feature = host.mergeFeatures({
      featureIds: ['f-1', 'f-2'],
      name: 'Merged feature',
    });

    expect(feature).toMatchObject({ id: 'f-1', name: 'Merged feature' });
    expect(host.draft.features.get('f-1')?.name).toBe('Merged feature');
    expect(host.draft.features.has('f-2')).toBe(false);
    expect(graph.features.has('f-2')).toBe(true);

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toContainEqual({
      kind: 'merge_features',
      featureIds: ['f-1', 'f-2'],
      name: 'Merged feature',
    });
  });

  it('reorders tasks on the draft graph only', () => {
    const graph = createGraphWithFeature();
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    const host = createProposalToolHost(graph, 'plan');

    const tasks = host.reorderTasks({
      featureId: 'f-1',
      taskIds: ['t-2', 't-1'],
    });

    expect(tasks.map((task) => task.id)).toEqual(['t-2', 't-1']);
    expect(host.draft.tasks.get('t-2')?.orderInFeature).toBe(0);
    expect(host.draft.tasks.get('t-1')?.orderInFeature).toBe(1);
    expect(graph.tasks.get('t-1')?.orderInFeature).toBe(0);
    expect(graph.tasks.get('t-2')?.orderInFeature).toBe(1);

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toContainEqual({
      kind: 'reorder_tasks',
      featureId: 'f-1',
      taskIds: ['t-2', 't-1'],
    });
  });

  it('stages proposal mutations on draft graph only', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    const task = host.addTask({
      featureId: 'f-1',
      description: 'Draft task',
      reservedWritePaths: ['src/new.ts'],
    });

    expect(task).toMatchObject({
      id: 't-1',
      featureId: 'f-1',
      description: 'Draft task',
      reservedWritePaths: ['src/new.ts'],
    });
    expect(host.draft.tasks.get('t-1')).toMatchObject({
      id: 't-1',
      featureId: 'f-1',
      description: 'Draft task',
      reservedWritePaths: ['src/new.ts'],
    });
    expect(graph.tasks.size).toBe(0);

    host.submit(proposalDetails);

    expect(host.wasSubmitted()).toBe(true);
    expect(host.getProposalDetails()).toEqual(proposalDetails);
    expect(host.buildProposal()).toEqual({
      version: 1,
      mode: 'plan',
      aliases: { '#1': 't-1' },
      ops: [
        {
          kind: 'add_task',
          taskId: '#1',
          featureId: 'f-1',
          description: 'Draft task',
          reservedWritePaths: ['src/new.ts'],
        },
      ],
    });
  });

  it('threads planner-baked task fields into draft + add_task op', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    const task = host.addTask({
      featureId: 'f-1',
      description: 'Planner-baked task',
      objective: 'Wire auth endpoint',
      scope: 'Only email/password, no OAuth',
      expectedFiles: ['src/auth/login.ts'],
      references: ['docs/auth.md'],
      outcomeVerification: 'Unit test covers 200 + 401',
      reservedWritePaths: ['src/auth/login.ts'],
    });

    expect(task).toMatchObject({
      objective: 'Wire auth endpoint',
      scope: 'Only email/password, no OAuth',
      expectedFiles: ['src/auth/login.ts'],
      references: ['docs/auth.md'],
      outcomeVerification: 'Unit test covers 200 + 401',
    });

    host.submit(proposalDetails);
    const proposal = host.buildProposal();
    const addOp = proposal.ops.find((op) => op.kind === 'add_task');
    expect(addOp).toMatchObject({
      kind: 'add_task',
      objective: 'Wire auth endpoint',
      scope: 'Only email/password, no OAuth',
      expectedFiles: ['src/auth/login.ts'],
      references: ['docs/auth.md'],
      outcomeVerification: 'Unit test covers 200 + 401',
    });
  });

  it('setFeatureObjective records edit_feature op and updates draft', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    const feature = host.setFeatureObjective({
      featureId: 'f-1',
      objective: 'Ship login by Friday',
    });

    expect(feature.featureObjective).toBe('Ship login by Friday');
    expect(host.draft.features.get('f-1')?.featureObjective).toBe(
      'Ship login by Friday',
    );
    expect(graph.features.get('f-1')?.featureObjective).toBeUndefined();

    host.submit(proposalDetails);
    const proposal = host.buildProposal();
    expect(proposal.ops).toContainEqual({
      kind: 'edit_feature',
      featureId: 'f-1',
      patch: { featureObjective: 'Ship login by Friday' },
    });
  });

  it('setFeatureDoD records edit_feature op with DoD array', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.setFeatureDoD({
      featureId: 'f-1',
      dod: ['login works', 'tests green'],
    });

    expect(host.draft.features.get('f-1')?.featureDoD).toEqual([
      'login works',
      'tests green',
    ]);

    host.submit(proposalDetails);
    const proposal = host.buildProposal();
    expect(proposal.ops).toContainEqual({
      kind: 'edit_feature',
      featureId: 'f-1',
      patch: { featureDoD: ['login works', 'tests green'] },
    });
  });

  it('editFeature with empty patch records no op', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.editFeature({ featureId: 'f-1', patch: {} });

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toEqual([]);
  });

  it('editFeature with patch matching current values records no op', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.editFeature({
      featureId: 'f-1',
      patch: { name: 'F', description: 'd' },
    });

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toEqual([]);
  });

  it('editFeature with partial match records only changed keys', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.editFeature({
      featureId: 'f-1',
      patch: { name: 'F', description: 'different' },
    });

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toEqual([
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { description: 'different' },
      },
    ]);
  });

  it('editFeature with identical featureDoD array records no op', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    host.setFeatureDoD({ featureId: 'f-1', dod: ['a', 'b'] });

    host.editFeature({
      featureId: 'f-1',
      patch: { featureDoD: ['a', 'b'] },
    });

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toHaveLength(1);
  });

  it('setFeatureObjective skips op when objective unchanged', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    host.setFeatureObjective({ featureId: 'f-1', objective: 'ship it' });

    host.setFeatureObjective({ featureId: 'f-1', objective: 'ship it' });

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toHaveLength(1);
  });

  it('setFeatureDoD skips op when DoD unchanged', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');
    host.setFeatureDoD({ featureId: 'f-1', dod: ['x'] });

    host.setFeatureDoD({ featureId: 'f-1', dod: ['x'] });

    host.submit(proposalDetails);
    expect(host.buildProposal().ops).toHaveLength(1);
  });

  it('emits aliases for newly added feature/task refs', () => {
    const graph = createGraphWithMilestone();
    const host = createProposalToolHost(graph, 'plan');

    const feature = host.addFeature({
      milestoneId: 'm-1',
      name: 'New',
      description: 'd',
    });
    const task = host.addTask({
      featureId: feature.id,
      description: 'Task',
    });

    host.submit(proposalDetails);
    const proposal = host.buildProposal();

    expect(proposal.ops[0]).toMatchObject({
      kind: 'add_feature',
      featureId: '#1',
      milestoneId: 'm-1',
    });
    expect(proposal.ops[1]).toMatchObject({
      kind: 'add_task',
      taskId: '#2',
      featureId: '#1',
    });
    expect(proposal.aliases).toEqual({ '#1': feature.id, '#2': task.id });
  });

  it('sequential apply of two host-built proposals allocates non-colliding real ids', () => {
    const graph = createGraphWithMilestone();

    const firstHost = createProposalToolHost(graph, 'plan');
    firstHost.addFeature({
      milestoneId: 'm-1',
      name: 'First',
      description: 'd',
    });
    firstHost.submit(proposalDetails);

    const secondHost = createProposalToolHost(graph, 'plan');
    secondHost.addFeature({
      milestoneId: 'm-1',
      name: 'Second',
      description: 'd',
    });
    secondHost.submit(proposalDetails);

    const firstResult = applyGraphProposal(graph, firstHost.buildProposal());
    const secondResult = applyGraphProposal(graph, secondHost.buildProposal());

    expect(firstResult.applied).toHaveLength(1);
    expect(secondResult.applied).toHaveLength(1);
    expect(firstResult.resolvedAliases['#1']).toBe('f-1');
    expect(secondResult.resolvedAliases['#1']).toBe('f-2');
    expect(graph.features.get('f-1')?.name).toBe('First');
    expect(graph.features.get('f-2')?.name).toBe('Second');
  });

  it('rejects duplicate submit and post-submit mutation', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.submit(proposalDetails);

    expect(() => host.submit(proposalDetails)).toThrow(
      'proposal already submitted',
    );
    expect(() =>
      host.addTask({
        featureId: 'f-1',
        description: 'late task',
      }),
    ).toThrow('proposal already submitted');
  });
});
