import type { GraphSnapshot } from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, FeaturePhaseAgentRun, Milestone } from '@core/types/index';
import {
  ComposerProposalController,
  type ComposerProposalEnvironment,
} from '@tui/proposal-controller';
import { describe, expect, it, vi } from 'vitest';

import { updateFeature } from '../../helpers/graph-builders.js';

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm-1',
    name: 'Milestone 1',
    description: 'desc',
    status: 'pending',
    order: 0,
    ...overrides,
  };
}

function makePlanningGraph(): InMemoryFeatureGraph {
  const graph = new InMemoryFeatureGraph();
  graph.createMilestone({ id: 'm-1', name: 'Milestone 1', description: 'desc' });
  graph.createFeature({
    id: 'f-1',
    milestoneId: 'm-1',
    name: 'Planner feature',
    description: 'desc',
  });
  updateFeature(graph, 'f-1', {
    workControl: 'planning',
    collabControl: 'none',
  });
  return graph;
}

function makeEnv(
  graph = makePlanningGraph(),
  overrides: Partial<ComposerProposalEnvironment> = {},
): ComposerProposalEnvironment {
  let autoEnabled = true;
  const runs = new Map<string, AgentRun>();

  return {
    snapshot: () => graph.snapshot(),
    isAutoExecutionEnabled: () => autoEnabled,
    setAutoExecutionEnabled: (enabled) => {
      autoEnabled = enabled;
      return autoEnabled;
    },
    getFeatureRun: (featureId, phase) => {
      const run = runs.get(`run-feature:${featureId}:${phase}`);
      return run?.scopeType === 'feature_phase' ? run : undefined;
    },
    saveFeatureRun: (run) => {
      runs.set(run.id, run);
    },
    enqueueApprovalDecision: vi.fn(),
    enqueueRerun: vi.fn(),
    ...overrides,
  };
}

describe('ComposerProposalController', () => {
  it('starts draft, stages feature op, and exposes draft snapshot', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    const controller = new ComposerProposalController(env);

    const result = await controller.execute('/feature-add --milestone m-1 --name "New feature" --description "Added from TUI"', {
      featureId: 'f-1',
    });

    expect(result.message).toContain('Added feature');
    expect(env.isAutoExecutionEnabled()).toBe(false);
    expect(controller.getDraftSnapshot()?.features).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'New feature' })]),
    );
    expect(graph.features.has('f-2')).toBe(false);
  });

  it('submits draft into await_approval feature run and restores auto mode', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    const controller = new ComposerProposalController(env);

    await controller.execute(
      '/task-add --feature f-1 --description "Draft task" --weight medium',
      { featureId: 'f-1' },
    );
    const result = await controller.execute('/submit', { featureId: 'f-1' });

    const run = env.getFeatureRun('f-1', 'plan') as FeaturePhaseAgentRun | undefined;
    expect(result.message).toContain('Submitted proposal');
    expect(run).toMatchObject({
      id: 'run-feature:f-1:plan',
      scopeType: 'feature_phase',
      scopeId: 'f-1',
      phase: 'plan',
      runStatus: 'await_approval',
      owner: 'manual',
    });
    expect(run?.payloadJson).toContain('add_task');
    expect(env.isAutoExecutionEnabled()).toBe(true);
    expect(controller.getDraftSnapshot()).toBeUndefined();
  });

  it('routes approve, reject, and rerun through environment callbacks', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph, {
      getFeatureRun: () => ({
        id: 'run-feature:f-1:plan',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'plan',
        runStatus: 'await_approval',
        owner: 'manual',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
      }),
    });
    const controller = new ComposerProposalController(env);

    await controller.execute('/approve', { featureId: 'f-1' });
    await controller.execute('/reject --comment "needs changes"', {
      featureId: 'f-1',
    });
    await controller.execute('/rerun', { featureId: 'f-1' });

    expect(env.enqueueApprovalDecision).toHaveBeenNthCalledWith(1, {
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
      comment: undefined,
    });
    expect(env.enqueueApprovalDecision).toHaveBeenNthCalledWith(2, {
      featureId: 'f-1',
      phase: 'plan',
      decision: 'rejected',
      comment: 'needs changes',
    });
    expect(env.enqueueRerun).toHaveBeenCalledWith({
      featureId: 'f-1',
      phase: 'plan',
    });
  });
});
