import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, TopPlannerAgentRun } from '@core/types/index';
import {
  ComposerProposalController,
  type ComposerProposalEnvironment,
} from '@tui/proposal-controller';
import { describe, expect, it, vi } from 'vitest';

import { updateFeature, updateTask } from '../../helpers/graph-builders.js';

function makePlanningGraph(): InMemoryFeatureGraph {
  const graph = new InMemoryFeatureGraph();
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
  return graph;
}

function makeTopPlannerRun(
  overrides: Partial<TopPlannerAgentRun> = {},
): TopPlannerAgentRun {
  return {
    id: 'run-top-planner',
    scopeType: 'top_planner',
    scopeId: 'top-planner',
    phase: 'plan',
    runStatus: 'await_approval',
    owner: 'manual',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeEnv(
  graph = makePlanningGraph(),
  overrides: Partial<
    Omit<
      ComposerProposalEnvironment,
      | 'enqueueApprovalDecision'
      | 'enqueueTopPlannerApprovalDecision'
      | 'enqueueRerun'
      | 'enqueueTopPlannerRerun'
    >
  > = {},
): ComposerProposalEnvironment & {
  enqueueApprovalDecision: ReturnType<typeof vi.fn>;
  enqueueTopPlannerApprovalDecision: ReturnType<typeof vi.fn>;
  enqueueRerun: ReturnType<typeof vi.fn>;
  enqueueTopPlannerRerun: ReturnType<typeof vi.fn>;
} {
  let autoEnabled = true;
  const runs = new Map<string, AgentRun>();
  const enqueueApprovalDecision = vi.fn();
  const enqueueTopPlannerApprovalDecision = vi.fn();
  const enqueueRerun = vi.fn();
  const enqueueTopPlannerRerun = vi.fn();

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
    getTopPlannerRun: () => {
      const run = runs.get('run-top-planner');
      return run?.scopeType === 'top_planner' ? run : undefined;
    },
    saveFeatureRun: (run) => {
      runs.set(run.id, run);
    },
    enqueueApprovalDecision,
    enqueueTopPlannerApprovalDecision,
    enqueueRerun,
    enqueueTopPlannerRerun,
    ...overrides,
  };
}

describe('ComposerProposalController', () => {
  it('starts draft, stages milestone op, and exposes draft snapshot', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    const controller = new ComposerProposalController(env);

    const result = await controller.execute(
      '/milestone-add --name "Milestone 2" --description "Added from TUI"',
      {
        featureId: 'f-1',
      },
    );

    expect(result.message).toContain('Added milestone');
    expect(env.isAutoExecutionEnabled()).toBe(false);
    expect(controller.getDraftSnapshot()?.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Milestone 2' }),
      ]),
    );
    expect(graph.milestones.has('m-2')).toBe(false);
  });

  it('starts draft, stages feature op, and exposes draft snapshot', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    const controller = new ComposerProposalController(env);

    const result = await controller.execute(
      '/feature-add --milestone m-1 --name "New feature" --description "Added from TUI"',
      {
        featureId: 'f-1',
      },
    );

    expect(result.message).toContain('Added feature');
    expect(env.isAutoExecutionEnabled()).toBe(false);
    expect(controller.getDraftSnapshot()?.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'New feature' }),
      ]),
    );
    expect(graph.features.has('f-2')).toBe(false);
  });

  it('submits draft into await_approval feature run and restores auto mode', async () => {
    const graph = makePlanningGraph();
    const env = makeEnv(graph);
    const controller = new ComposerProposalController(env);

    await controller.execute(
      '/milestone-add --name "Milestone 2" --description "Added from TUI"',
      { featureId: 'f-1' },
    );
    await controller.execute(
      '/task-add --feature f-1 --description "Draft task" --weight medium',
      { featureId: 'f-1' },
    );
    const result = await controller.execute('/submit', { featureId: 'f-1' });

    const run = env.getFeatureRun('f-1', 'plan');
    expect(result.message).toContain('Submitted proposal');
    expect(run).toMatchObject({
      id: 'run-feature:f-1:plan',
      scopeType: 'feature_phase',
      scopeId: 'f-1',
      phase: 'plan',
      runStatus: 'await_approval',
      owner: 'manual',
    });
    expect(run?.payloadJson).toContain('add_milestone');
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

  it('requests top-planner rerun session selection when the UI hook handles it', async () => {
    const requestTopPlannerRerunSelection = vi.fn(() => true);
    const env = makeEnv(makePlanningGraph(), {
      getTopPlannerRun: () => makeTopPlannerRun(),
      requestTopPlannerRerunSelection,
    });
    const controller = new ComposerProposalController(env);

    const result = await controller.execute('/rerun');

    expect(result.message).toBe(
      'Choose continue or fresh for top-planner rerun.',
    );
    expect(requestTopPlannerRerunSelection).toHaveBeenCalledTimes(1);
    expect(env.enqueueTopPlannerRerun).not.toHaveBeenCalled();
  });

  it('falls back to direct top-planner rerun when no session picker hook is installed', async () => {
    const env = makeEnv(makePlanningGraph(), {
      getTopPlannerRun: () => makeTopPlannerRun(),
    });
    const controller = new ComposerProposalController(env);

    const result = await controller.execute('/rerun');

    expect(result.message).toBe('Requested rerun for top-planner.');
    expect(env.enqueueTopPlannerRerun).toHaveBeenCalledWith();
  });

  it('discards draft and restores prior auto-execution state', async () => {
    const env = makeEnv();
    env.setAutoExecutionEnabled(false);
    const controller = new ComposerProposalController(env);

    await controller.execute(
      '/task-add --description "Draft task" --weight medium',
      { featureId: 'f-1' },
    );

    expect(env.isAutoExecutionEnabled()).toBe(false);
    expect(controller.getDraftSnapshot()).toBeDefined();

    const result = await controller.execute('/discard');

    expect(result.message).toContain('Discarded draft');
    expect(env.isAutoExecutionEnabled()).toBe(false);
    expect(controller.getDraftSnapshot()).toBeUndefined();
    expect(controller.getDraftState()).toBeUndefined();
  });

  it('tracks draft command count across multiple planner commands', async () => {
    const controller = new ComposerProposalController(makeEnv());

    await controller.execute(
      '/task-add --description "Draft task" --weight medium',
      { featureId: 'f-1' },
    );
    await controller.execute(
      '/task-edit --task t-1 --description "Updated draft task"',
      { featureId: 'f-1' },
    );

    expect(controller.getDraftState()).toEqual({
      featureId: 'f-1',
      phase: 'plan',
      commandCount: 2,
    });
  });

  it('uses selection fallback for feature, task, and milestone ids', async () => {
    const graph = makePlanningGraph();
    graph.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'Existing task',
    });
    const controller = new ComposerProposalController(makeEnv(graph));

    await controller.execute('/task-edit --description "Edited task"', {
      featureId: 'f-1',
      taskId: 't-1',
    });
    await controller.execute(
      '/feature-add --name "Selection feature" --description "Uses selection"',
      { featureId: 'f-1', milestoneId: 'm-1' },
    );

    const draftSnapshot = controller.getDraftSnapshot();
    expect(draftSnapshot?.tasks.find((task) => task.id === 't-1')).toEqual(
      expect.objectContaining({ description: 'Edited task' }),
    );
    expect(
      draftSnapshot?.features.some(
        (feature) => feature.name === 'Selection feature',
      ),
    ).toBe(true);
  });

  it('stages feature move on the draft graph', async () => {
    const graph = makePlanningGraph();
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'desc',
    });
    const controller = new ComposerProposalController(makeEnv(graph));

    const result = await controller.execute(
      '/feature-move --feature f-1 --milestone m-2',
      { featureId: 'f-1' },
    );

    expect(result.message).toBe('Moved feature f-1 to milestone m-2.');
    expect(
      controller
        .getDraftSnapshot()
        ?.features.find((feature) => feature.id === 'f-1'),
    ).toEqual(expect.objectContaining({ milestoneId: 'm-2' }));
    expect(graph.features.get('f-1')?.milestoneId).toBe('m-1');
  });

  it('stages feature split, merge, and task reorder on the draft graph', async () => {
    const graph = makePlanningGraph();
    graph.createFeature({
      id: 'f-2',
      milestoneId: 'm-1',
      name: 'Second feature',
      description: 'desc',
    });
    updateFeature(graph, 'f-2', {
      workControl: 'planning',
      collabControl: 'none',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    const controller = new ComposerProposalController(makeEnv(graph));

    await controller.execute(
      '/feature-split --feature f-2 "api|API feature|API work" "ui|UI feature|UI work|api"',
      { featureId: 'f-1' },
    );
    const splitSnapshot = controller.getDraftSnapshot();
    expect(
      splitSnapshot?.features.find((feature) => feature.id === 'f-3'),
    ).toEqual(expect.objectContaining({ name: 'API feature', dependsOn: [] }));
    expect(
      splitSnapshot?.features.find((feature) => feature.id === 'f-4'),
    ).toEqual(
      expect.objectContaining({ name: 'UI feature', dependsOn: ['f-3'] }),
    );

    const mergeResult = await controller.execute(
      '/feature-merge --name "Merged feature" f-3 f-4',
      { featureId: 'f-1' },
    );
    const reorderResult = await controller.execute(
      '/task-reorder --feature f-1 t-2 t-1',
      { featureId: 'f-1' },
    );

    const draftSnapshot = controller.getDraftSnapshot();
    const reorderedTasks = draftSnapshot?.tasks
      .filter((task) => task.featureId === 'f-1')
      .sort((left, right) => left.orderInFeature - right.orderInFeature)
      .map((task) => task.id);
    expect(mergeResult.message).toBe('Merged features into f-3.');
    expect(reorderResult.message).toBe('Reordered 2 tasks in feature f-1.');
    expect(
      draftSnapshot?.features.find((feature) => feature.id === 'f-3'),
    ).toEqual(expect.objectContaining({ name: 'Merged feature' }));
    expect(
      draftSnapshot?.features.some((feature) => feature.id === 'f-2'),
    ).toBe(false);
    expect(
      draftSnapshot?.features.some((feature) => feature.id === 'f-4'),
    ).toBe(false);
    expect(reorderedTasks).toEqual(['t-2', 't-1']);
  });

  it('rejects malformed split specs, duplicate split aliases, missing merge ids, and incomplete reorder lists', async () => {
    const graph = makePlanningGraph();
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    const controller = new ComposerProposalController(makeEnv(graph));

    await expect(
      controller.execute('/feature-split --feature f-1 "api|API feature"', {
        featureId: 'f-1',
      }),
    ).rejects.toThrow('invalid split spec "api|API feature"');
    await expect(
      controller.execute(
        '/feature-split --feature f-1 "api|API feature|API work" "api|UI feature|UI work"',
        { featureId: 'f-1' },
      ),
    ).rejects.toThrow('duplicate split alias "api"');
    await expect(
      controller.execute('/feature-merge --name "Merged feature"', {
        featureId: 'f-1',
      }),
    ).rejects.toThrow('feature merge requires at least two feature ids');
    await expect(
      controller.execute('/task-reorder --feature f-1 t-1', {
        featureId: 'f-1',
      }),
    ).rejects.toThrow(
      'task reorder requires all 2 tasks for feature "f-1", got 1',
    );
  });

  it('rejects missing selection or draft preconditions with exact messages', async () => {
    const controller = new ComposerProposalController(makeEnv());

    await expect(
      controller.execute(
        '/task-add --description "Draft task" --weight medium',
      ),
    ).rejects.toThrow('select planning or replanning feature first');
    await expect(controller.execute('/submit')).rejects.toThrow(
      'no active draft to submit',
    );
    await expect(controller.execute('/discard')).rejects.toThrow(
      'no active draft to discard',
    );
    await expect(controller.execute('/approve')).rejects.toThrow(
      'select feature with pending proposal first',
    );
  });

  it('rejects missing pending proposal and non-planning feature approval', async () => {
    const planningGraph = makePlanningGraph();
    const controller = new ComposerProposalController(makeEnv(planningGraph));

    await expect(
      controller.execute('/approve', { featureId: 'f-1' }),
    ).rejects.toThrow('feature "f-1" has no pending proposal');

    const graph = makePlanningGraph();
    updateFeature(graph, 'f-1', { workControl: 'executing' });
    const controllerForExecuting = new ComposerProposalController(
      makeEnv(graph),
    );

    await expect(
      controllerForExecuting.execute('/approve', { featureId: 'f-1' }),
    ).rejects.toThrow('feature "f-1" is not in planning or replanning');
  });

  it('rejects invalid draft edit inputs and mixed dependency endpoints', async () => {
    const graph = makePlanningGraph();
    graph.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'Existing task',
    });
    updateTask(graph, 't-1', { weight: 'small' });
    const controller = new ComposerProposalController(makeEnv(graph));

    await expect(
      controller.execute('/feature-edit --feature f-1', { featureId: 'f-1' }),
    ).rejects.toThrow('feature edit requires at least one patch field');
    await expect(
      controller.execute('/task-edit --task t-1', { featureId: 'f-1' }),
    ).rejects.toThrow('task edit requires at least one patch field');
    await expect(
      controller.execute('/task-add --description "Draft task" --weight huge', {
        featureId: 'f-1',
      }),
    ).rejects.toThrow('invalid task weight "huge"');
    await expect(
      controller.execute('/dep-add --from f-1 --to t-1', { featureId: 'f-1' }),
    ).rejects.toThrow(
      'dependency endpoints must both be features or both be tasks',
    );
  });
});
