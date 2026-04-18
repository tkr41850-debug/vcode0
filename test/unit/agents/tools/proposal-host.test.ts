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
