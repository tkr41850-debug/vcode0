import type { InMemoryFeatureGraph } from '@core/graph/index';
import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import { applyGraphProposal } from '@core/proposals/index';
import type { AgentRun } from '@core/types/index';
import {
  applyProjectProposal,
  approveFeatureProposal,
  type ProposalRebaseReason,
} from '@orchestrator/proposals/index';
import { describe, expect, it } from 'vitest';
import {
  createGraphWithFeature,
  createGraphWithTask,
  updateFeature,
  updateTask,
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

describe('applyProjectProposal — graphVersion CAS', () => {
  it('applies all ops and advances graphVersion by exactly one', () => {
    const graph = createGraphWithFeature();
    const before = graph.graphVersion;
    const proposal = buildProposal('plan', [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'do thing' },
      },
    ]);

    const outcome = applyProjectProposal({
      graph,
      proposal,
      baselineGraphVersion: before,
      agentRuns: [],
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.result.applied.length).toBe(1);
    }
    expect(graph.graphVersion).toBe(before + 1);
  });

  it('rejects stale baseline as a whole with ProposalRebaseReason stale-baseline', () => {
    const graph = createGraphWithFeature();
    const baseline = graph.graphVersion;
    const intervening = buildProposal('plan', [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'intervening edit' },
      },
    ]);
    applyGraphProposal(graph, intervening);
    expect(graph.graphVersion).toBe(baseline + 1);

    const stale = buildProposal('plan', [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'stale edit' },
      },
    ]);
    const before = graph.graphVersion;
    const outcome = applyProjectProposal({
      graph,
      proposal: stale,
      baselineGraphVersion: baseline,
      agentRuns: [],
    });

    expect(outcome.kind).toBe('rebase');
    if (outcome.kind === 'rebase') {
      const reason: ProposalRebaseReason = outcome.reason;
      expect(reason.kind).toBe('stale-baseline');
    }
    expect(graph.graphVersion).toBe(before);
    const feature = graph.features.get('f-1');
    expect(feature?.featureObjective).toBe('intervening edit');
  });

  it('feature-scope apply between propose and apply bumps graphVersion (project apply then sees stale)', () => {
    const graph = createGraphWithFeature();
    inPlanning(graph);
    const baseline = graph.graphVersion;

    const featureProposal = buildProposal('plan', [
      {
        kind: 'add_task',
        taskId: 't-feat',
        featureId: 'f-1',
        description: 'feature-scope add',
      },
    ]);
    approveFeatureProposal(graph, 'f-1', 'plan', featureProposal);
    expect(graph.graphVersion).toBe(baseline + 1);

    const projectProposal = buildProposal('plan', [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'project edit' },
      },
    ]);
    const outcome = applyProjectProposal({
      graph,
      proposal: projectProposal,
      baselineGraphVersion: baseline,
      agentRuns: [],
    });

    expect(outcome.kind).toBe('rebase');
    if (outcome.kind === 'rebase') {
      expect(outcome.reason.kind).toBe('stale-baseline');
    }
  });

  it('rejects with running-tasks-affected when removed feature has a running task run', () => {
    const graph = createGraphWithTask();
    updateTask(graph, 't-1', { status: 'running' });
    const baseline = graph.graphVersion;

    const runs: AgentRun[] = [
      {
        id: 'run-task:t-1',
        scopeType: 'task',
        scopeId: 't-1',
        phase: 'execute',
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
      },
    ];

    const proposal = buildProposal('plan', [
      { kind: 'remove_feature', featureId: 'f-1' },
    ]);

    const outcome = applyProjectProposal({
      graph,
      proposal,
      baselineGraphVersion: baseline,
      agentRuns: runs,
    });

    expect(outcome.kind).toBe('rebase');
    if (outcome.kind === 'rebase') {
      expect(outcome.reason.kind).toBe('running-tasks-affected');
      if (outcome.reason.kind === 'running-tasks-affected') {
        expect(outcome.reason.details.featureIds).toContain('f-1');
      }
    }
    expect(graph.graphVersion).toBe(baseline);
    expect(graph.features.has('f-1')).toBe(true);
  });

  it('rejects with running-tasks-affected when edited feature has a running feature_phase run', () => {
    const graph = createGraphWithFeature();
    const baseline = graph.graphVersion;

    const runs: AgentRun[] = [
      {
        id: 'run-feature:f-1:plan',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'plan',
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
      },
    ];

    const proposal = buildProposal('plan', [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'change' },
      },
    ]);

    const outcome = applyProjectProposal({
      graph,
      proposal,
      baselineGraphVersion: baseline,
      agentRuns: runs,
    });

    expect(outcome.kind).toBe('rebase');
    if (outcome.kind === 'rebase') {
      expect(outcome.reason.kind).toBe('running-tasks-affected');
    }
    expect(graph.graphVersion).toBe(baseline);
  });

  it('rejects with running-tasks-affected when add_dependency endpoint targets a feature with a running run', () => {
    const graph = createGraphWithFeature();
    const baseline = graph.graphVersion;

    const runs: AgentRun[] = [
      {
        id: 'run-feature:f-1:plan',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'plan',
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
      },
    ];

    const proposal = buildProposal('plan', [
      { kind: 'add_dependency', fromId: 'f-2', toId: 'f-1' },
    ]);

    const outcome = applyProjectProposal({
      graph,
      proposal,
      baselineGraphVersion: baseline,
      agentRuns: runs,
    });

    expect(outcome.kind).toBe('rebase');
    if (outcome.kind === 'rebase') {
      expect(outcome.reason.kind).toBe('running-tasks-affected');
      if (outcome.reason.kind === 'running-tasks-affected') {
        expect(outcome.reason.details.featureIds).toContain('f-1');
      }
    }
    expect(graph.graphVersion).toBe(baseline);
  });

  it('feature-scope approveFeatureProposal continues to apply unchanged (per-op stale-skip preserved) and bumps graphVersion exactly once', () => {
    const graph = createGraphWithTask();
    updateFeature(graph, 'f-1', { workControl: 'replanning' });
    updateTask(graph, 't-1', { status: 'pending' });
    const baseline = graph.graphVersion;

    const proposal = buildProposal('replan', [
      { kind: 'remove_task', taskId: 't-missing' },
      {
        kind: 'add_task',
        taskId: 't-2',
        featureId: 'f-1',
        description: 'second',
      },
    ]);

    const outcome = approveFeatureProposal(graph, 'f-1', 'replan', proposal);

    expect(outcome.result.skipped.length).toBe(1);
    expect(outcome.result.applied.length).toBe(1);
    expect(graph.graphVersion).toBe(baseline + 1);
  });
});
