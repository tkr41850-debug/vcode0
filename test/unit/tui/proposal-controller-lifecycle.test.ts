import { InMemoryFeatureGraph } from '@core/graph/index';
import type { GraphProposal } from '@core/proposals/index';
import type { AgentRun } from '@core/types/index';
import {
  ComposerProposalController,
  type ComposerProposalEnvironment,
} from '@tui/proposal-controller';
import { describe, expect, it, vi } from 'vitest';

import { updateFeature } from '../../helpers/graph-builders.js';

function makePlanningGraph(): InMemoryFeatureGraph {
  const graph = new InMemoryFeatureGraph();
  graph.__enterTick();
  try {
    graph.createMilestone({
      id: 'm-1',
      name: 'Milestone 1',
      description: 'desc',
    });
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
  } finally {
    graph.__leaveTick();
  }
  return graph;
}

function makeEnv(
  graph = makePlanningGraph(),
  overrides: Partial<
    Omit<
      ComposerProposalEnvironment,
      'enqueueApprovalDecision' | 'enqueueRerun'
    >
  > = {},
): ComposerProposalEnvironment & {
  enqueueApprovalDecision: ReturnType<typeof vi.fn>;
  enqueueRerun: ReturnType<typeof vi.fn>;
} {
  let autoEnabled = true;
  const runs = new Map<string, AgentRun>();
  const enqueueApprovalDecision = vi.fn();
  const enqueueRerun = vi.fn();

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
    enqueueApprovalDecision,
    enqueueRerun,
    ...overrides,
  };
}

describe('ComposerProposalController lifecycle methods', () => {
  it('submitDraft persists payload as parseable GraphProposal JSON', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    const controller = new ComposerProposalController(env);

    await controller.execute(
      '/task-add --feature f-1 --description "Draft task" --weight medium',
      { featureId: 'f-1' },
    );
    const result = await controller.execute('/submit', { featureId: 'f-1' });

    const run = env.getFeatureRun('f-1', 'plan');
    expect(result.message).toContain('Submitted proposal');
    expect(run?.payloadJson).toBeDefined();

    const parsed = JSON.parse(run?.payloadJson ?? '{}') as GraphProposal;
    expect(parsed).toMatchObject({
      version: 1,
      mode: 'plan',
    });
    expect(Array.isArray(parsed.ops)).toBe(true);
    expect(parsed.ops.length).toBeGreaterThan(0);
  });

  it('submitDraft restores auto-execution when prior state was disabled', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    env.setAutoExecutionEnabled(false);
    const controller = new ComposerProposalController(env);

    await controller.execute(
      '/task-add --feature f-1 --description "Draft task" --weight medium',
      { featureId: 'f-1' },
    );
    expect(env.isAutoExecutionEnabled()).toBe(false);

    const result = await controller.execute('/submit', { featureId: 'f-1' });

    expect(result.message).toContain('Submitted proposal');
    expect(env.isAutoExecutionEnabled()).toBe(false);
  });

  it('rejectPending without --comment omits comment field', async () => {
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

    await controller.execute('/reject', { featureId: 'f-1' });

    const calls = env.enqueueApprovalDecision.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const rejectCall = calls[calls.length - 1];
    expect(rejectCall).toBeDefined();
    const args = rejectCall?.[0] as Record<string, unknown>;
    expect(args).toHaveProperty('decision', 'rejected');
    expect('comment' in args).toBe(false);
  });

  it('approvePending forwards correct phase for a replan run', async () => {
    const graph = makePlanningGraph();
    updateFeature(graph, 'f-1', {
      workControl: 'replanning',
      collabControl: 'none',
    });
    const env = makeEnv(graph, {
      getFeatureRun: () => ({
        id: 'run-feature:f-1:replan',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'replan',
        runStatus: 'await_approval',
        owner: 'manual',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
      }),
    });
    const controller = new ComposerProposalController(env);

    await controller.execute('/approve', { featureId: 'f-1' });

    const calls = env.enqueueApprovalDecision.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const approveCall = calls[calls.length - 1];
    expect(approveCall).toBeDefined();
    const args = approveCall?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({
      decision: 'approved',
      phase: 'replan',
    });
  });
});
