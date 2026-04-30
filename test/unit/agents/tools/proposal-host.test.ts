import {
  createProposalToolHost,
  type GraphProposalHostEvent,
} from '@agents/tools';
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

  it('allows multiple submit() calls (checkpoint-style); last details win', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.addTask({ featureId: 'f-1', description: 'first' });
    host.submit(proposalDetails);

    expect(host.wasSubmitted()).toBe(true);

    host.addTask({ featureId: 'f-1', description: 'second' });
    const revisedDetails: ProposalPhaseDetails = {
      ...proposalDetails,
      summary: 'Revised plan.',
    };
    expect(() => host.submit(revisedDetails)).not.toThrow();

    expect(host.getProposalDetails().summary).toBe('Revised plan.');
    const proposal = host.buildProposal();
    expect(proposal.ops).toHaveLength(2);
    expect(proposal.ops[0]).toMatchObject({
      kind: 'add_task',
      description: 'first',
    });
    expect(proposal.ops[1]).toMatchObject({
      kind: 'add_task',
      description: 'second',
    });
  });

  it('allows mutations after submit; they accumulate into next buildProposal', () => {
    const graph = createGraphWithFeature();
    const host = createProposalToolHost(graph, 'plan');

    host.submit(proposalDetails);

    expect(() =>
      host.addTask({
        featureId: 'f-1',
        description: 'late task',
      }),
    ).not.toThrow();

    expect(host.buildProposal().ops).toHaveLength(1);
  });

  describe('subscribe()', () => {
    it('notifies subscribers in op order with op_recorded events', () => {
      const graph = createGraphWithMilestone();
      const host = createProposalToolHost(graph, 'plan');
      const events: GraphProposalHostEvent[] = [];
      host.subscribe((event) => {
        events.push(event);
      });

      const feature = host.addFeature({
        milestoneId: 'm-1',
        name: 'F',
        description: 'd',
      });
      host.addTask({ featureId: feature.id, description: 'T' });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'op_recorded',
        op: { kind: 'add_feature' },
      });
      expect(events[1]).toMatchObject({
        kind: 'op_recorded',
        op: { kind: 'add_task' },
      });
    });

    it('op_recorded carries draft snapshot reflecting prefix of mutations', () => {
      const graph = createGraphWithMilestone();
      const host = createProposalToolHost(graph, 'plan');
      const snapshots: number[] = [];
      host.subscribe((event) => {
        if (event.kind === 'op_recorded') {
          snapshots.push(event.draftSnapshot.features.length);
        }
      });

      host.addFeature({
        milestoneId: 'm-1',
        name: 'A',
        description: 'd',
      });
      host.addFeature({
        milestoneId: 'm-1',
        name: 'B',
        description: 'd',
      });

      expect(snapshots).toEqual([1, 2]);
    });

    it('returned unsubscribe stops further callbacks', () => {
      const graph = createGraphWithMilestone();
      const host = createProposalToolHost(graph, 'plan');
      const events: GraphProposalHostEvent[] = [];
      const unsubscribe = host.subscribe((event) => {
        events.push(event);
      });

      host.addFeature({ milestoneId: 'm-1', name: 'A', description: 'd' });
      unsubscribe();
      host.addFeature({ milestoneId: 'm-1', name: 'B', description: 'd' });

      expect(events).toHaveLength(1);
    });

    it('listener that unsubscribes itself mid-emission does not break peers and stops on next op', () => {
      const graph = createGraphWithMilestone();
      const host = createProposalToolHost(graph, 'plan');
      const eventsA: GraphProposalHostEvent[] = [];
      const eventsB: GraphProposalHostEvent[] = [];
      const eventsC: GraphProposalHostEvent[] = [];

      host.subscribe((e) => eventsA.push(e));
      let unsubB: (() => void) | undefined;
      unsubB = host.subscribe((e) => {
        eventsB.push(e);
        unsubB?.();
      });
      host.subscribe((e) => eventsC.push(e));

      host.addFeature({ milestoneId: 'm-1', name: 'A', description: 'd' });
      host.addFeature({ milestoneId: 'm-1', name: 'B', description: 'd' });

      expect(eventsA).toHaveLength(2);
      expect(eventsB).toHaveLength(1);
      expect(eventsC).toHaveLength(2);
    });

    it('preserves registration order across multiple ops', () => {
      const graph = createGraphWithMilestone();
      const host = createProposalToolHost(graph, 'plan');
      const order: string[] = [];

      host.subscribe(() => order.push('A'));
      host.subscribe(() => order.push('B'));
      host.subscribe(() => order.push('C'));

      host.addFeature({ milestoneId: 'm-1', name: 'F1', description: 'd' });
      host.addFeature({ milestoneId: 'm-1', name: 'F2', description: 'd' });

      expect(order).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
    });

    it('multiple subscribers each receive the full op stream', () => {
      const graph = createGraphWithMilestone();
      const host = createProposalToolHost(graph, 'plan');
      const eventsA: GraphProposalHostEvent[] = [];
      const eventsB: GraphProposalHostEvent[] = [];
      host.subscribe((e) => eventsA.push(e));
      host.subscribe((e) => eventsB.push(e));

      host.addFeature({ milestoneId: 'm-1', name: 'A', description: 'd' });

      expect(eventsA).toHaveLength(1);
      expect(eventsB).toHaveLength(1);
      expect(eventsA[0]).toEqual(eventsB[0]);
    });

    it('emits submitted event with submissionIndex on each submit', () => {
      const graph = createGraphWithFeature();
      const host = createProposalToolHost(graph, 'plan');
      const events: GraphProposalHostEvent[] = [];
      host.subscribe((event) => {
        events.push(event);
      });

      host.addTask({ featureId: 'f-1', description: 'first' });
      host.submit(proposalDetails);
      host.addTask({ featureId: 'f-1', description: 'second' });
      host.submit({ ...proposalDetails, summary: 'second pass' });

      const submissionEvents = events.filter((e) => e.kind === 'submitted');
      expect(submissionEvents).toHaveLength(2);
      expect(submissionEvents[0]).toMatchObject({
        kind: 'submitted',
        submissionIndex: 1,
        details: { summary: 'Plan ready.' },
      });
      expect(submissionEvents[1]).toMatchObject({
        kind: 'submitted',
        submissionIndex: 2,
        details: { summary: 'second pass' },
      });
      expect(
        (
          submissionEvents[1] as Extract<
            GraphProposalHostEvent,
            { kind: 'submitted' }
          >
        ).proposal.ops,
      ).toHaveLength(2);
    });

    it('does not fire op_recorded if mutation throws', () => {
      const graph = createGraphWithFeature();
      const host = createProposalToolHost(graph, 'plan');
      const events: GraphProposalHostEvent[] = [];
      host.subscribe((e) => events.push(e));

      expect(() =>
        host.removeFeature({ featureId: 'f-does-not-exist' as never }),
      ).toThrow();

      expect(events).toHaveLength(0);
    });
  });
});
