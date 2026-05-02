import type {
  Feature,
  FeaturePhaseAgentRun,
  Milestone,
  ProjectAgentRun,
  Task,
  TaskAgentRun,
} from '@core/types/index';
import { PROJECT_SCOPE_ID } from '@core/types/index';
import { visibleWidth } from '@mariozechner/pi-tui';
import { CommandRegistry, NAVIGATION_KEYBINDS } from '@tui/commands/index';
import {
  AgentMonitorOverlay,
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  StatusBar,
} from '@tui/components/index';
import {
  bucketRunsByScope,
  deriveInitialMode,
  flattenDagNodes,
  TuiViewModelBuilder,
} from '@tui/view-model/index';
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

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-task:t-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeFeatureRun(
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: 'run-feature:f-1:plan',
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase: 'plan',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeProjectRun(
  overrides: Partial<ProjectAgentRun> = {},
): ProjectAgentRun {
  return {
    id: 'run-project:p-1',
    scopeType: 'project',
    scopeId: PROJECT_SCOPE_ID,
    phase: 'plan',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe('TuiViewModelBuilder', () => {
  it('marks waiting task runs as blocked in DAG nodes', () => {
    const builder = new TuiViewModelBuilder();
    const nodes = flattenDagNodes(
      builder.buildMilestoneTree(
        [makeMilestone()],
        [makeFeature()],
        [makeTask()],
        [makeTaskRun({ runStatus: 'await_response' })],
        100,
      ),
    );

    const taskNode = nodes.find((node) => node.id === 't-1');
    expect(taskNode).toMatchObject({
      id: 't-1',
      displayStatus: 'blocked',
      icon: '⏸',
      runStatus: 'await_response',
    });
    expect(taskNode?.meta).toContain('wait: await_response');
  });

  it('marks waiting feature-phase runs as blocked in feature nodes', () => {
    const builder = new TuiViewModelBuilder();
    const nodes = flattenDagNodes(
      builder.buildMilestoneTree(
        [makeMilestone()],
        [makeFeature({ workControl: 'planning', collabControl: 'none' })],
        [],
        [makeFeatureRun({ runStatus: 'await_approval' })],
        100,
      ),
    );

    const featureNode = nodes.find((node) => node.id === 'f-1');
    expect(featureNode).toMatchObject({
      id: 'f-1',
      displayStatus: 'blocked',
      icon: '⏸',
      runStatus: 'await_approval',
    });
    expect(featureNode?.meta).toContain('wait: await_approval');
  });

  it('marks failed feature-phase runs with the failed icon and inbox hint', () => {
    const builder = new TuiViewModelBuilder();
    const nodes = flattenDagNodes(
      builder.buildMilestoneTree(
        [makeMilestone()],
        [makeFeature({ workControl: 'planning', collabControl: 'none' })],
        [],
        [makeFeatureRun({ runStatus: 'failed' })],
        100,
      ),
    );

    const featureNode = nodes.find((node) => node.id === 'f-1');
    expect(featureNode).toMatchObject({
      id: 'f-1',
      displayStatus: 'blocked',
      icon: '✗',
      runStatus: 'failed',
    });
    expect(featureNode?.meta).toContain('wait: failed (see inbox)');
  });

  it('groups project-scope runs into a distinct projectRuns bucket', () => {
    const taskRun = makeTaskRun();
    const featureRun = makeFeatureRun();
    const projectRun = makeProjectRun({ id: 'run-project:planner-1' });

    const buckets = bucketRunsByScope([taskRun, featureRun, projectRun]);

    expect(buckets.projectRuns.get(projectRun.id)).toBe(projectRun);
    expect(buckets.featurePhaseRuns.has(`${projectRun.scopeId}:plan`)).toBe(
      false,
    );
    expect(buckets.taskRuns.get(taskRun.scopeId)).toBe(taskRun);
    expect(buckets.featurePhaseRuns.get(`${featureRun.scopeId}:plan`)).toBe(
      featureRun,
    );
  });

  it('keeps running feature-phase rendering unchanged when not blocked or failed', () => {
    const builder = new TuiViewModelBuilder();
    const nodes = flattenDagNodes(
      builder.buildMilestoneTree(
        [makeMilestone()],
        [makeFeature({ workControl: 'planning', collabControl: 'none' })],
        [],
        [makeFeatureRun({ runStatus: 'running' })],
        100,
      ),
    );

    const featureNode = nodes.find((node) => node.id === 'f-1');
    expect(featureNode?.icon).toBe('⟳');
    expect(featureNode?.displayStatus).not.toBe('blocked');
    expect(featureNode?.meta?.some((m) => m.startsWith('wait:'))).toBe(false);
  });

  it('builds task interaction composer status', () => {
    const builder = new TuiViewModelBuilder();

    expect(
      builder.buildComposer({
        text: '',
        focusMode: 'composer',
        pendingTaskId: 't-1',
        pendingTaskRunStatus: 'await_response',
        pendingTaskOwner: 'manual',
        pendingTaskPayloadJson: JSON.stringify({
          query: 'Need operator guidance',
        }),
      }),
    ).toMatchObject({
      mode: 'task',
      detail: 'task await_response manual t-1 q=Need operator guidance /reply',
    });

    expect(
      builder.buildComposer({
        text: '',
        focusMode: 'composer',
        pendingTaskId: 't-1',
        pendingTaskRunStatus: 'await_approval',
        pendingTaskOwner: 'manual',
        pendingTaskPayloadJson: JSON.stringify({
          summary: 'Switch to fallback task order',
          proposedMutations: ['move t-2 after t-3'],
        }),
      }),
    ).toMatchObject({
      mode: 'task',
      detail:
        'task await_approval manual t-1 ask=Switch to fallback task order /approve /reject',
    });

    expect(
      builder.buildComposer({
        text: '',
        focusMode: 'composer',
        pendingTaskId: 't-1',
        pendingTaskRunStatus: 'running',
        pendingTaskOwner: 'manual',
      }),
    ).toMatchObject({
      mode: 'task',
      detail: 'task running manual t-1 /input',
    });
  });

  it('builds live-planner composer status with op + submission counts', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      liveProposalFeatureId: 'f-1',
      liveProposalPhase: 'plan',
      liveProposalOpCount: 7,
      liveProposalSubmissionCount: 0,
    });

    expect(vm).toMatchObject({
      mode: 'live-planner',
      detail: 'live planner f-1 plan 7 ops',
    });
  });

  it('live-planner composer detail surfaces submission count when ≥1 submitted', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      liveProposalFeatureId: 'f-2',
      liveProposalPhase: 'replan',
      liveProposalOpCount: 12,
      liveProposalSubmissionCount: 2,
    });

    expect(vm.detail).toBe('live planner f-2 replan 12 ops 2 submitted');
  });

  it('attached composer shows reply guidance when await_response', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      attachedFeatureId: 'f-1',
      attachedPhase: 'plan',
      attachedRunStatus: 'await_response',
    });
    expect(vm.mode).toBe('attached');
    expect(vm.detail).toContain('attached f-1 plan await_response');
    expect(vm.detail).toContain('/reply');
    expect(vm.detail).toContain('/release-to-scheduler');
  });

  it('attached composer shows chat hint when running', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      attachedFeatureId: 'f-2',
      attachedPhase: 'replan',
      attachedRunStatus: 'running',
    });
    expect(vm.mode).toBe('attached');
    expect(vm.detail).toContain('attached f-2 replan running');
    expect(vm.detail).toContain('[type to chat]');
  });

  it('manual draft takes precedence over live-planner mode in composer', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      draftFeatureId: 'f-1',
      draftPhase: 'plan',
      draftCommandCount: 3,
      liveProposalFeatureId: 'f-1',
      liveProposalPhase: 'plan',
      liveProposalOpCount: 99,
      liveProposalSubmissionCount: 0,
    });

    expect(vm.mode).toBe('draft');
    expect(vm.detail).toContain('draft plan f-1 3 ops');
  });

  it('status bar accepts live-planner dataMode', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildStatusBar({
      tasks: [],
      workerCounts: { runningWorkers: 0, idleWorkers: 1, totalWorkers: 1 },
      autoExecutionEnabled: false,
      keybindHints: [],
      dataMode: 'live-planner',
    });

    expect(vm.dataMode).toBe('live-planner');
  });

  it('composer scope defaults to graph in command mode', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
    });
    expect(vm.composerScope).toEqual({ kind: 'graph' });
  });

  it('composer scope is graph when in draft mode', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      draftFeatureId: 'f-1',
      draftPhase: 'plan',
      draftCommandCount: 1,
    });
    expect(vm.composerScope).toEqual({ kind: 'graph' });
  });

  it('composer scope is project when projectSessionId is set', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      projectSessionId: 'run-project:abc',
    });
    expect(vm.composerScope).toEqual({
      kind: 'project',
      sessionId: 'run-project:abc',
    });
  });

  it('composer scope is feature when attached to feature plan/replan', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      attachedFeatureId: 'f-1',
      attachedPhase: 'plan',
      attachedRunStatus: 'running',
    });
    expect(vm.composerScope).toEqual({ kind: 'feature', featureId: 'f-1' });
  });

  it('composer scope is feature in live-planner mode', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      liveProposalFeatureId: 'f-2',
      liveProposalPhase: 'replan',
      liveProposalOpCount: 3,
    });
    expect(vm.composerScope).toEqual({ kind: 'feature', featureId: 'f-2' });
  });

  it('composer scope is feature in approval mode for plan/replan', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      pendingProposalPhase: 'plan',
      pendingFeatureId: 'f-3',
    });
    expect(vm.composerScope).toEqual({ kind: 'feature', featureId: 'f-3' });
  });

  it('composer scope persists when composer is defocused (focusMode=graph)', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'graph',
      projectSessionId: 'run-project:xyz',
    });
    expect(vm.composerScope).toEqual({
      kind: 'project',
      sessionId: 'run-project:xyz',
    });
  });

  it('composer scope project takes precedence over feature attached', () => {
    const builder = new TuiViewModelBuilder();
    const vm = builder.buildComposer({
      text: '',
      focusMode: 'composer',
      projectSessionId: 'run-project:p',
      attachedFeatureId: 'f-1',
      attachedPhase: 'plan',
      attachedRunStatus: 'running',
    });
    expect(vm.composerScope).toEqual({
      kind: 'project',
      sessionId: 'run-project:p',
    });
  });

  it('includes milestone drafting command in idle composer hint', () => {
    const builder = new TuiViewModelBuilder();
    const composer = builder.buildComposer({
      text: '',
      focusMode: 'composer',
    });

    expect(composer).toMatchObject({
      mode: 'command',
      detail: expect.stringContaining('/milestone-add'),
    });
  });

  it('includes milestone queue order and status-bar cost totals', () => {
    const builder = new TuiViewModelBuilder();
    const tree = builder.buildMilestoneTree(
      [makeMilestone({ steeringQueuePosition: 0 })],
      [makeFeature()],
      [
        makeTask({
          id: 't-1',
          status: 'done',
          tokenUsage: {
            llmCalls: 1,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            audioInputTokens: 0,
            audioOutputTokens: 0,
            totalTokens: 15,
            usd: 1.25,
            byModel: {},
          },
        }),
        makeTask({
          id: 't-2',
          orderInFeature: 1,
          tokenUsage: {
            llmCalls: 1,
            inputTokens: 20,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            audioInputTokens: 0,
            audioOutputTokens: 0,
            totalTokens: 30,
            usd: 2,
            byModel: {},
          },
        }),
      ],
      [],
      100,
    );

    expect(tree[0]).toMatchObject({
      id: 'm-1',
      queuePosition: 0,
    });
    expect(tree[0]?.meta).toContain('queue: 1');

    const statusBar = builder.buildStatusBar({
      tasks: [
        makeTask({
          status: 'done',
          tokenUsage: {
            llmCalls: 1,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            audioInputTokens: 0,
            audioOutputTokens: 0,
            totalTokens: 15,
            usd: 1.25,
            byModel: {},
          },
        }),
        makeTask({
          id: 't-2',
          orderInFeature: 1,
          tokenUsage: {
            llmCalls: 1,
            inputTokens: 20,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            audioInputTokens: 0,
            audioOutputTokens: 0,
            totalTokens: 30,
            usd: 2,
            byModel: {},
          },
        }),
      ],
      workerCounts: {
        runningWorkers: 2,
        idleWorkers: 1,
        totalWorkers: 3,
      },
      autoExecutionEnabled: true,
      keybindHints: [...NAVIGATION_KEYBINDS, ...new CommandRegistry().getAll()],
    });

    expect(statusBar).toMatchObject({
      runningWorkers: 2,
      totalWorkers: 3,
      completedTasks: 1,
      totalTasks: 2,
      totalUsd: 3.25,
      autoExecutionEnabled: true,
    });
    expect(statusBar.keybindHints.map((hint) => hint.key)).toContain('h');
  });

  it('builds dependency detail with dependency and dependent labels', () => {
    const builder = new TuiViewModelBuilder();
    const detail = builder.buildDependencyDetail(
      'f-1',
      [makeMilestone()],
      [
        makeFeature({ id: 'f-1', name: 'Feature 1', dependsOn: ['f-2'] }),
        makeFeature({ id: 'f-2', name: 'Feature 2' }),
        makeFeature({ id: 'f-3', name: 'Feature 3', dependsOn: ['f-1'] }),
      ],
    );

    expect(detail).toMatchObject({
      featureId: 'f-1',
      milestoneLabel: 'm-1: Milestone 1',
      dependsOn: ['f-2: Feature 2'],
      dependents: ['f-3: Feature 3'],
    });
  });
});

describe('deriveInitialMode', () => {
  it('returns project-planner mode attached to session id for greenfield-bootstrap', () => {
    const mode = deriveInitialMode({
      kind: 'greenfield-bootstrap',
      sessionId: 'run-project:s-1',
    });
    expect(mode).toEqual({
      kind: 'project-planner',
      sessionId: 'run-project:s-1',
    });
  });

  it('returns graph mode for existing-project bootstrap', () => {
    const mode = deriveInitialMode({ kind: 'existing' });
    expect(mode).toEqual({ kind: 'graph' });
  });

  it('returns graph mode when bootstrap result is undefined', () => {
    const mode = deriveInitialMode(undefined);
    expect(mode).toEqual({ kind: 'graph' });
  });
});

describe('TUI components', () => {
  it('renders help overlay from keybind list', () => {
    const overlay = new HelpOverlay();
    overlay.setModel('Help', [
      ...NAVIGATION_KEYBINDS,
      ...new CommandRegistry().getAll(),
    ]);

    const output = overlay.render(80).join('\n');
    expect(output).toContain('Help');
    expect(output).toContain('h');
    expect(output).toContain('help');
    expect(output).toContain('space');
  });

  it('renders status bar keybind summary from model hints', () => {
    const statusBar = new StatusBar();
    statusBar.setModel({
      autoExecutionEnabled: false,
      runningWorkers: 0,
      idleWorkers: 1,
      totalWorkers: 1,
      completedTasks: 0,
      totalTasks: 0,
      totalUsd: 0,
      keybindHints: [...NAVIGATION_KEYBINDS, ...new CommandRegistry().getAll()],
    });

    const output = statusBar.render(120).join('\n');
    expect(output).toContain('keys:');
    expect(output).toContain('h help');
    expect(output).toContain('↑↓ move');
  });

  it('keeps rendered lines within requested width', () => {
    const statusBar = new StatusBar();
    statusBar.setModel({
      autoExecutionEnabled: false,
      runningWorkers: 0,
      idleWorkers: 0,
      totalWorkers: 0,
      completedTasks: 0,
      totalTasks: 0,
      totalUsd: 0,
      keybindHints: [...NAVIGATION_KEYBINDS, ...new CommandRegistry().getAll()],
    });
    const helpOverlay = new HelpOverlay();
    helpOverlay.setModel('Help', [
      ...NAVIGATION_KEYBINDS,
      ...new CommandRegistry().getAll(),
    ]);
    const dagView = new DagView();
    dagView.setModel([], undefined, 'gvc0 progress');
    const dependencyOverlay = new DependencyDetailOverlay();

    for (const width of [1, 2, 4, 8, 16]) {
      for (const line of statusBar.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of helpOverlay.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of dagView.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of dependencyOverlay.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('AgentMonitorOverlay', () => {
  it('keeps only recent log lines and cycles worker selection', () => {
    const overlay = new AgentMonitorOverlay();

    for (let index = 0; index < 205; index++) {
      overlay.upsertLog('run-1', 't-1', `line-${index}`, index);
    }
    overlay.upsertLog('run-2', 't-2', 'other-line', 500);

    const logs = overlay.getLogs();
    const run1 = logs.find((entry) => entry.id === 'run-1');

    expect(run1?.lines).toHaveLength(200);
    expect(run1?.lines[0]).toBe('line-5');
    expect(logs[0]?.id).toBe('run-2');

    overlay.setSelectedWorker('run-1');
    expect(overlay.cycleSelection()).toBe('run-2');
    expect(overlay.cycleSelection()).toBe('run-1');
  });

  it('renders placeholder text when no worker logs exist', () => {
    const overlay = new AgentMonitorOverlay();
    const output = overlay.render(90).join('\n');

    expect(output).toContain('No worker output yet.');
    expect(output).toContain('Waiting for worker progress');
  });
});
