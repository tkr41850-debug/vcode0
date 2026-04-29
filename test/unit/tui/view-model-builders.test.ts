import type {
  Feature,
  Milestone,
  Task,
  TokenUsageAggregate,
} from '@core/types/index';
import { TuiViewModelBuilder } from '@tui/view-model/index';
import { describe, expect, it } from 'vitest';

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

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f-1',
    milestoneId: 'm-1',
    orderInMilestone: 0,
    name: 'Feature 1',
    description: 'desc',
    dependsOn: [],
    status: 'pending',
    workControl: 'executing',
    collabControl: 'branch_open',
    featureBranch: 'feat-feature-1-f-1',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    featureId: 'f-1',
    orderInFeature: 0,
    description: 'Task 1',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
    ...overrides,
  };
}

function makeTokenUsage(usd: number): TokenUsageAggregate {
  return {
    llmCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens: 0,
    usd,
    byModel: {},
  };
}

describe('TuiViewModelBuilder.buildMilestoneTree', () => {
  it('empty milestones returns empty array', () => {
    const builder = new TuiViewModelBuilder();
    const result = builder.buildMilestoneTree([], [], []);
    expect(result).toHaveLength(0);
  });

  it('milestones sorted by order field', () => {
    const builder = new TuiViewModelBuilder();
    const milestones = [
      makeMilestone({ id: 'm-2', order: 2 }),
      makeMilestone({ id: 'm-0', order: 0 }),
      makeMilestone({ id: 'm-1', order: 1 }),
    ];
    const result = builder.buildMilestoneTree(milestones, [], []);

    expect(result).toHaveLength(3);
    expect(result.at(0)?.id).toBe('m-0');
    expect(result.at(1)?.id).toBe('m-1');
    expect(result.at(2)?.id).toBe('m-2');
  });

  it('features grouped under their milestone', () => {
    const builder = new TuiViewModelBuilder();
    const milestones = [
      makeMilestone({ id: 'm-1' }),
      makeMilestone({ id: 'm-2' }),
    ];
    const features = [
      makeFeature({ id: 'f-1', milestoneId: 'm-1' }),
      makeFeature({ id: 'f-2', milestoneId: 'm-1' }),
      makeFeature({ id: 'f-3', milestoneId: 'm-2' }),
    ];

    const result = builder.buildMilestoneTree(milestones, features, []);

    expect(result).toHaveLength(2);

    expect(result.at(0)?.id).toBe('m-1');
    expect(result.at(0)?.children).toBeDefined();
    expect(result.at(0)?.children?.length).toBe(2);
    expect(result.at(0)?.children?.at(0)?.id).toBe('f-1');
    expect(result.at(0)?.children?.at(1)?.id).toBe('f-2');

    expect(result.at(1)?.id).toBe('m-2');
    expect(result.at(1)?.children).toBeDefined();
    expect(result.at(1)?.children?.length).toBe(1);
    expect(result.at(1)?.children?.at(0)?.id).toBe('f-3');
  });
});

describe('TuiViewModelBuilder.buildStatusBar', () => {
  it('completedTasks counts done tasks', () => {
    const builder = new TuiViewModelBuilder();
    const tasks = [
      makeTask({ id: 't-1', status: 'done' }),
      makeTask({ id: 't-2', status: 'done' }),
      makeTask({ id: 't-3', status: 'ready' }),
    ];

    const result = builder.buildStatusBar({
      tasks,
      workerCounts: { runningWorkers: 0, idleWorkers: 0, totalWorkers: 0 },
      autoExecutionEnabled: true,
      keybindHints: [],
    });

    expect(result.completedTasks).toBe(2);
    expect(result.totalTasks).toBe(3);
  });

  it('totalUsd sums tokenUsage.usd', () => {
    const builder = new TuiViewModelBuilder();
    const tasks = [
      makeTask({ id: 't-1', tokenUsage: makeTokenUsage(0.5) }),
      makeTask({ id: 't-2', tokenUsage: makeTokenUsage(1.5) }),
    ];

    const result = builder.buildStatusBar({
      tasks,
      workerCounts: { runningWorkers: 0, idleWorkers: 0, totalWorkers: 0 },
      autoExecutionEnabled: true,
      keybindHints: [],
    });

    expect(result.totalUsd).toBe(2);
  });

  it('totalUsd includes tasks without tokenUsage as 0', () => {
    const builder = new TuiViewModelBuilder();
    const tasks = [
      makeTask({ id: 't-1', tokenUsage: makeTokenUsage(1) }),
      makeTask({ id: 't-2' }),
    ];

    const result = builder.buildStatusBar({
      tasks,
      workerCounts: { runningWorkers: 0, idleWorkers: 0, totalWorkers: 0 },
      autoExecutionEnabled: true,
      keybindHints: [],
    });

    expect(result.totalUsd).toBe(1);
  });

  it('passes through optional fields when set', () => {
    const builder = new TuiViewModelBuilder();

    const result = builder.buildStatusBar({
      tasks: [],
      workerCounts: { runningWorkers: 0, idleWorkers: 0, totalWorkers: 0 },
      autoExecutionEnabled: true,
      keybindHints: [],
      selectedLabel: 'sel',
      notice: 'hi',
      dataMode: 'live',
      focusMode: 'composer',
      pendingProposalPhase: 'plan',
    });

    expect(result).toHaveProperty('selectedLabel', 'sel');
    expect(result).toHaveProperty('notice', 'hi');
    expect(result).toHaveProperty('dataMode', 'live');
    expect(result).toHaveProperty('focusMode', 'composer');
    expect(result).toHaveProperty('pendingProposalPhase', 'plan');
  });

  it('omits optional fields when not set', () => {
    const builder = new TuiViewModelBuilder();

    const result = builder.buildStatusBar({
      tasks: [],
      workerCounts: { runningWorkers: 0, idleWorkers: 0, totalWorkers: 0 },
      autoExecutionEnabled: true,
      keybindHints: [],
    });

    expect(result).not.toHaveProperty('selectedLabel');
    expect(result).not.toHaveProperty('notice');
    expect(result).not.toHaveProperty('dataMode');
    expect(result).not.toHaveProperty('focusMode');
    expect(result).not.toHaveProperty('pendingProposalPhase');
  });
});
