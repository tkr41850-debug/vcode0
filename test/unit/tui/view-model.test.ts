import type { GvcConfig } from '@config';
import type {
  Feature,
  FeaturePhaseAgentRun,
  Milestone,
  Task,
  TaskAgentRun,
  TopPlannerAgentRun,
} from '@core/types/index';
import { visibleWidth } from '@mariozechner/pi-tui';
import type { InboxItemRecord } from '@orchestrator/ports/index';
import { pendingProposalForSelection } from '@tui/app-state';
import { CommandRegistry, NAVIGATION_KEYBINDS } from '@tui/commands/index';
import {
  AgentMonitorOverlay,
  ConfigOverlay,
  DagView,
  DependencyDetailOverlay,
  HelpOverlay,
  InboxOverlay,
  MergeTrainOverlay,
  StatusBar,
  TaskTranscriptOverlay,
} from '@tui/components/index';
import { flattenDagNodes, TuiViewModelBuilder } from '@tui/view-model/index';
import { describe, expect, it } from 'vitest';

import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';

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

function makeInboxItem(
  overrides: Partial<InboxItemRecord> = {},
): InboxItemRecord {
  return {
    id: 'inbox-1',
    ts: 1,
    taskId: 't-1',
    agentRunId: 'run-task:t-1',
    featureId: 'f-1',
    kind: 'agent_help',
    payload: { query: 'Need operator guidance' },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced',
    ...overrides,
  };
}

describe('TuiViewModelBuilder', () => {
  it.each([
    'await_response',
    'checkpointed_await_response',
  ] as const)('marks %s task runs as blocked in DAG nodes', (runStatus) => {
    const builder = new TuiViewModelBuilder();
    const nodes = flattenDagNodes(
      builder.buildMilestoneTree(
        [makeMilestone()],
        [makeFeature()],
        [makeTask()],
        [makeTaskRun({ runStatus })],
        100,
      ),
    );

    const taskNode = nodes.find((node) => node.id === 't-1');
    expect(taskNode).toMatchObject({
      id: 't-1',
      displayStatus: 'blocked',
      icon: '⏸',
      runStatus,
    });
    expect(taskNode?.meta).toContain(`wait: ${runStatus}`);
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

  it('builds approval composer status with collision hint', () => {
    const builder = new TuiViewModelBuilder();

    expect(
      builder.buildComposer({
        text: '',
        focusMode: 'composer',
        pendingProposalPhase: 'plan',
        pendingProposalTarget: 'top-planner',
        pendingProposalHint: 'resets 2 planner runs',
      }),
    ).toMatchObject({
      mode: 'approval',
      detail:
        'approval plan top-planner (resets 2 planner runs) /approve /reject /rerun',
    });
  });

  it('derives collision hint from pending top-planner metadata', () => {
    const pending = pendingProposalForSelection({
      draftState: undefined,
      selectedFeatureId: undefined,
      authoritativeSnapshot: {
        milestones: [],
        features: [],
        tasks: [],
      },
      getFeatureRun: () => undefined,
      getTopPlannerRun: () =>
        makeTopPlannerRun({
          payloadJson: JSON.stringify({
            version: 1,
            mode: 'plan',
            aliases: {},
            ops: [],
            topPlannerMeta: {
              prompt: 'rebalance roadmap',
              sessionMode: 'fresh',
              runId: 'run-top-planner',
              sessionId: 'sess-top',
              featureIds: ['f-1', 'f-2'],
              milestoneIds: ['m-1'],
              collidedFeatureRuns: [
                {
                  featureId: 'f-1',
                  runId: 'run-feature:f-1:plan',
                  phase: 'plan',
                  runStatus: 'await_approval',
                },
                {
                  featureId: 'f-2',
                  runId: 'run-feature:f-2:replan',
                  phase: 'replan',
                  runStatus: 'running',
                },
              ],
            },
          }),
        }),
    });

    expect(pending).toMatchObject({
      run: expect.objectContaining({ scopeType: 'top_planner', phase: 'plan' }),
      approvalHint: 'resets 2 planner runs',
    });
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
        pendingTaskRunStatus: 'checkpointed_await_response',
        pendingTaskOwner: 'manual',
        pendingTaskPayloadJson: JSON.stringify({
          query: 'Need operator guidance',
        }),
      }),
    ).toMatchObject({
      mode: 'task',
      detail:
        'task checkpointed_await_response manual t-1 q=Need operator guidance /reply',
    });

    expect(
      builder.buildComposer({
        text: '',
        focusMode: 'composer',
        pendingTaskId: 't-1',
        pendingTaskRunStatus: 'checkpointed_await_approval',
        pendingTaskOwner: 'manual',
        pendingTaskPayloadJson: JSON.stringify({
          summary: 'Switch to fallback task order',
          proposedMutations: ['move t-2 after t-3'],
        }),
      }),
    ).toMatchObject({
      mode: 'task',
      detail:
        'task checkpointed_await_approval manual t-1 ask=Switch to fallback task order /approve /reject',
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

  it('builds unresolved inbox items newest first with summarized context', () => {
    const builder = new TuiViewModelBuilder();
    const model = builder.buildInbox([
      makeInboxItem({
        id: 'inbox-older',
        ts: 10,
        payload: { query: 'Need operator guidance' },
      }),
      makeInboxItem({
        id: 'inbox-resolved',
        ts: 20,
        resolution: { kind: 'answered', resolvedAt: 25 },
      }),
      {
        id: 'inbox-newer',
        ts: 30,
        featureId: 'f-1',
        kind: 'merge_train_cap_reached',
        payload: { cap: 3, reentryCount: 2, reason: 'train paused' },
      },
      {
        id: 'inbox-recovery',
        ts: 25,
        taskId: 't-1',
        featureId: 'f-1',
        agentRunId: 'run-task:t-1',
        kind: 'semantic_failure',
        payload: {
          reason: 'resume_incomplete',
          recoveryReason: 'missing-tool-outputs:tool-a,tool-b',
        },
      },
    ]);

    expect(model).toMatchObject({
      unresolvedCount: 3,
      items: [
        {
          id: 'inbox-newer',
          kind: 'merge_train_cap_reached',
          summary: 'feature=f-1 merge cap 2/3 train paused',
        },
        {
          id: 'inbox-recovery',
          kind: 'semantic_failure',
          summary: 'task=t-1 feature=f-1 recovery missing tool outputs tool-a,tool-b',
        },
        {
          id: 'inbox-older',
          kind: 'agent_help',
          summary: 'task=t-1 feature=f-1 q=Need operator guidance',
        },
      ],
    });
  });

  it('builds merge-train items with integrating first and queued priority order', () => {
    const builder = new TuiViewModelBuilder();
    const model = builder.buildMergeTrain([
      makeFeature({
        id: 'f-1',
        name: 'Integrating feature',
        collabControl: 'integrating',
        mergeTrainManualPosition: 1,
        mergeTrainEntrySeq: 4,
        mergeTrainReentryCount: 0,
      }),
      makeFeature({
        id: 'f-2',
        name: 'Manual queued',
        collabControl: 'merge_queued',
        mergeTrainManualPosition: 2,
        mergeTrainEntrySeq: 3,
        mergeTrainReentryCount: 0,
      }),
      makeFeature({
        id: 'f-3',
        name: 'Reentry queued',
        collabControl: 'merge_queued',
        mergeTrainEntrySeq: 2,
        mergeTrainReentryCount: 2,
      }),
      makeFeature({
        id: 'f-4',
        name: 'Later queued',
        collabControl: 'merge_queued',
        mergeTrainEntrySeq: 5,
        mergeTrainReentryCount: 0,
      }),
    ]);

    expect(model).toMatchObject({
      integratingCount: 1,
      queuedCount: 3,
      items: [
        {
          featureId: 'f-1',
          state: 'integrating',
          summary: 'manual: 1 reentry: 0 entry: 4',
        },
        {
          featureId: 'f-2',
          state: 'queued',
          summary: 'manual: 2 reentry: 0 entry: 3',
        },
        {
          featureId: 'f-3',
          state: 'queued',
          summary: 'reentry: 2 entry: 2',
        },
        {
          featureId: 'f-4',
          state: 'queued',
          summary: 'reentry: 0 entry: 5',
        },
      ],
    });
  });

  it('builds config entries from authoritative config', () => {
    const builder = new TuiViewModelBuilder();
    const model = builder.buildConfig(
      makeConfig({
        models: {
          topPlanner: { provider: 'anthropic', model: 'claude-opus-4-7' },
          featurePlanner: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
          },
          taskWorker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
          verifier: { provider: 'bedrock', model: 'verify-v2' },
        },
        workerCap: 6,
        retryCap: 7,
        reentryCap: 11,
        pauseTimeouts: { hotWindowMs: 42_000 },
      }),
    );

    expect(model).toEqual({
      entries: [
        { key: 'models.topPlanner', value: 'anthropic:claude-opus-4-7' },
        { key: 'models.featurePlanner', value: 'anthropic:claude-sonnet-4-6' },
        { key: 'models.taskWorker', value: 'anthropic:claude-haiku-4-5' },
        { key: 'models.verifier', value: 'bedrock:verify-v2' },
        { key: 'workerCap', value: '6' },
        { key: 'retryCap', value: '7' },
        { key: 'reentryCap', value: '11' },
        { key: 'pauseTimeouts.hotWindowMs', value: '42000' },
      ],
    });
  });

  it('builds task transcript for no selection, matching logs, and missing logs', () => {
    const builder = new TuiViewModelBuilder();

    expect(builder.buildTaskTranscript(undefined, [])).toEqual({
      taskId: undefined,
      label: 'no task selected',
      lines: [],
    });

    expect(
      builder.buildTaskTranscript('t-1', [
        {
          id: 'run-1',
          label: 't-1',
          taskId: 't-1',
          agentRunId: 'run-1',
          lines: ['line 1', 'line 2'],
          updatedAt: 1,
        },
      ]),
    ).toEqual({
      taskId: 't-1',
      label: 't-1',
      lines: ['line 1', 'line 2'],
    });

    expect(builder.buildTaskTranscript('t-9', [])).toEqual({
      taskId: 't-9',
      label: 't-9',
      lines: [],
    });
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

  it('renders approval hint in status bar', () => {
    const statusBar = new StatusBar();
    statusBar.setModel({
      autoExecutionEnabled: false,
      runningWorkers: 0,
      idleWorkers: 1,
      totalWorkers: 1,
      completedTasks: 0,
      totalTasks: 0,
      totalUsd: 0,
      keybindHints: [],
      pendingProposalPhase: 'plan',
      pendingProposalTarget: 'top-planner',
      pendingProposalHint: 'resets 2 planner runs',
    });

    const output = statusBar.render(120).join('\n');
    expect(output).toContain('approval: plan (resets 2 planner runs)');
  });

  it('renders inbox overlay items and empty state', () => {
    const overlay = new InboxOverlay();
    overlay.setModel({
      unresolvedCount: 1,
      items: [
        {
          id: 'inbox-1',
          kind: 'agent_help',
          taskId: 't-1',
          featureId: 'f-1',
          summary: 'task=t-1 feature=f-1 q=Need operator guidance',
          ts: 1,
        },
      ],
    });

    const populated = overlay.render(80).join('\n');
    expect(populated).toContain('Inbox [1 pending]');
    expect(populated).toContain(
      'inbox-1 [agent_help] task=t-1 feature=f-1 q=Need operator guidance',
    );

    overlay.setModel({ unresolvedCount: 0, items: [] });
    const empty = overlay.render(80).join('\n');
    expect(empty).toContain('No pending inbox items.');
  });

  it('renders merge-train overlay items and empty state', () => {
    const overlay = new MergeTrainOverlay();
    overlay.setModel({
      integratingCount: 1,
      queuedCount: 1,
      items: [
        {
          featureId: 'f-1',
          label: 'f-1: Integrating feature',
          state: 'integrating',
          summary: 'manual: 1 reentry: 0 entry: 4',
          manualPosition: 1,
          reentryCount: 0,
        },
        {
          featureId: 'f-2',
          label: 'f-2: Queued feature',
          state: 'queued',
          summary: 'reentry: 1 entry: 5',
          reentryCount: 1,
        },
      ],
    });

    const populated = overlay.render(80).join('\n');
    expect(populated).toContain('Merge Train [1 active, 1 queued]');
    expect(populated).toContain(
      'f-1: Integrating feature [integrating] manual: 1 reentry: 0 entry: 4',
    );
    expect(populated).toContain(
      'f-2: Queued feature [queued] reentry: 1 entry: 5',
    );

    overlay.setModel({ integratingCount: 0, queuedCount: 0, items: [] });
    const empty = overlay.render(80).join('\n');
    expect(empty).toContain('No integrating or queued features.');
  });

  it('renders config overlay entries and empty state', () => {
    const overlay = new ConfigOverlay();
    overlay.setModel({
      entries: [
        { key: 'workerCap', value: '6' },
        { key: 'models.verifier', value: 'bedrock:verify-v2' },
      ],
    });

    const populated = overlay.render(80).join('\n');
    expect(populated).toContain('Config [c/q/esc hide]');
    expect(populated).toContain('workerCap = 6');
    expect(populated).toContain('models.verifier = bedrock:verify-v2');
    expect(populated).toContain(
      'Use /config-set --key <path> --value "..." to update a value.',
    );

    overlay.setModel({ entries: [] });
    const empty = overlay.render(80).join('\n');
    expect(empty).toContain('No editable config values.');
  });

  it('renders transcript overlay placeholder and recent lines', () => {
    const overlay = new TaskTranscriptOverlay();

    overlay.setModel({
      taskId: undefined,
      label: 'no task selected',
      lines: [],
    });
    expect(overlay.render(80).join('\n')).toContain('No task selected.');

    overlay.setModel({
      taskId: 't-1',
      label: 't-1',
      lines: [],
    });
    expect(overlay.render(80).join('\n')).toContain('No output yet.');

    overlay.setModel({
      taskId: 't-1',
      label: 't-1',
      lines: ['line 1', 'line 2'],
    });
    const populated = overlay.render(80).join('\n');
    expect(populated).toContain('Transcript: t-1');
    expect(populated).toContain('line 1');
    expect(populated).toContain('line 2');
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
    const inboxOverlay = new InboxOverlay();
    inboxOverlay.setModel({
      unresolvedCount: 1,
      items: [
        {
          id: 'inbox-1',
          kind: 'agent_help',
          summary: 'task=t-1 feature=f-1 q=Need operator guidance',
          ts: 1,
        },
      ],
    });
    const mergeTrainOverlay = new MergeTrainOverlay();
    mergeTrainOverlay.setModel({
      integratingCount: 1,
      queuedCount: 1,
      items: [
        {
          featureId: 'f-1',
          label: 'f-1: Integrating feature',
          state: 'integrating',
          summary: 'manual: 1 reentry: 0 entry: 4',
          manualPosition: 1,
          reentryCount: 0,
        },
      ],
    });
    const configOverlay = new ConfigOverlay();
    configOverlay.setModel({
      entries: [{ key: 'workerCap', value: '6' }],
    });
    const transcriptOverlay = new TaskTranscriptOverlay();
    transcriptOverlay.setModel({
      taskId: 't-1',
      label: 't-1',
      lines: ['line 1', 'line 2'],
    });

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
      for (const line of inboxOverlay.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of mergeTrainOverlay.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of configOverlay.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of transcriptOverlay.render(width)) {
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
