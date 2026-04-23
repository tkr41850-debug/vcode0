import type { InMemoryFeatureGraph } from '@core/graph/index';
import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import { approveFeatureProposal } from '@orchestrator/proposals/index';
import { describe, expect, it } from 'vitest';
import {
  createGraphWithFeature,
  createGraphWithTask,
  updateFeature,
} from '../../../helpers/graph-builders.js';

function buildProposal(
  mode: 'plan' | 'replan',
  ops: GraphProposalOp[],
): GraphProposal {
  return { version: 1, mode, aliases: {}, ops };
}

function inPlanning(graph: InMemoryFeatureGraph): InMemoryFeatureGraph {
  updateFeature(graph, 'f-1', { workControl: 'planning' });
  return graph;
}

describe('approveFeatureProposal — empty-proposal cancels feature', () => {
  it('cancels feature when plan proposal adds no tasks and feature has none', () => {
    const graph = inPlanning(createGraphWithFeature());
    const proposal = buildProposal('plan', []);

    const outcome = approveFeatureProposal(graph, 'f-1', 'plan', proposal);

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('cancelled');
    expect(outcome.cancelled).toBe(true);
    expect(outcome.cancelReason).toBe('empty_proposal');
  });

  it('cancels feature when replan removes the last remaining task', () => {
    const graph = createGraphWithTask();
    updateFeature(graph, 'f-1', { workControl: 'replanning' });
    const proposal = buildProposal('replan', [
      { kind: 'remove_task', taskId: 't-1' },
    ]);

    const outcome = approveFeatureProposal(graph, 'f-1', 'replan', proposal);

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('cancelled');
    expect(outcome.cancelled).toBe(true);
  });

  it('does not cancel when proposal adds at least one task', () => {
    const graph = inPlanning(createGraphWithFeature());
    const proposal = buildProposal('plan', [
      { kind: 'add_task', taskId: 't-1', featureId: 'f-1', description: 'T' },
    ]);

    const outcome = approveFeatureProposal(graph, 'f-1', 'plan', proposal);

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).not.toBe('cancelled');
    expect(outcome.cancelled).toBe(false);
  });

  it('cancels when only metadata edits are applied on an already-empty feature', () => {
    const graph = inPlanning(createGraphWithFeature());
    const proposal = buildProposal('plan', [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'do thing' },
      },
    ]);

    const outcome = approveFeatureProposal(graph, 'f-1', 'plan', proposal);

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('cancelled');
    expect(outcome.cancelled).toBe(true);
  });

  it('returns the apply result alongside the cancellation flag', () => {
    const graph = inPlanning(createGraphWithFeature());
    const proposal = buildProposal('plan', []);

    const outcome = approveFeatureProposal(graph, 'f-1', 'plan', proposal);

    expect(outcome.result.applied).toEqual([]);
    expect(outcome.result.proposal).toBe(proposal);
  });
});
