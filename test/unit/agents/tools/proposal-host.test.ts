import { createProposalToolHost } from '@agents/tools';
import type { ProposalPhaseDetails } from '@core/types/index';
import { describe, expect, it } from 'vitest';

import { createGraphWithFeature } from '../../../helpers/graph-builders.js';

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
      aliases: {},
      ops: [
        {
          kind: 'add_milestone',
          milestoneId: 'm-2',
          name: 'Milestone 2',
          description: 'second milestone',
        },
      ],
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
          taskId: 't-1',
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
