import type { GvcConfig } from '@config';
import type { TaskAgentRun } from '@core/types/index';
import { CombinedAutocompleteProvider } from '@mariozechner/pi-tui';
import { executeSlashCommand, handleComposerSubmit } from '@tui/app-composer';
import {
  hasVisibleOverlay,
  shouldRenderAfterWorkerOutput,
} from '@tui/app-overlays';
import {
  buildComposerSlashCommands,
  INITIALIZE_PROJECT_EXAMPLE_COMMAND,
  parseInitializeProjectCommand,
  parseSlashCommand,
} from '@tui/commands/index';
import { describe, expect, it, vi } from 'vitest';

import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-task:t-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'await_response',
    owner: 'manual',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
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

function createDataSource(taskRun?: TaskAgentRun) {
  let config = makeConfig();

  return {
    snapshot: () => ({ milestones: [], features: [], tasks: [] }),
    listAgentRuns: () => [],
    listInboxItems: vi.fn(() => []),
    getConfig: vi.fn(() => config),
    updateConfig: vi.fn(async (nextConfig: GvcConfig) => {
      config = nextConfig;
      return nextConfig;
    }),
    getWorkerCounts: () => ({
      runningWorkers: 0,
      idleWorkers: 0,
      totalWorkers: 0,
    }),
    isAutoExecutionEnabled: () => true,
    setAutoExecutionEnabled: () => true,
    toggleAutoExecution: () => true,
    initializeProject: vi.fn(),
    toggleMilestoneQueue: vi.fn(),
    setMergeTrainManualPosition: vi.fn(),
    cancelFeature: vi.fn(),
    cancelTaskPreserveWorktree: vi.fn(async () => {}),
    cancelTaskCleanWorktree: vi.fn(async () => {}),
    abandonFeatureBranch: vi.fn(async () => {}),
    saveFeatureRun: vi.fn(),
    getFeatureRun: vi.fn(),
    getTopPlannerRun: vi.fn(),
    requestTopLevelPlan: vi.fn(() => 'Queued top-level planning request.'),
    getTaskRun: vi.fn(() => taskRun),
    enqueueApprovalDecision: vi.fn(),
    enqueueTopPlannerApprovalDecision: vi.fn(),
    rerunFeatureProposal: vi.fn(),
    rerunTopPlannerProposal: vi.fn(),
    respondToInboxHelp: vi.fn(async () => 'help sent'),
    decideInboxApproval: vi.fn(async () => 'decision sent'),
    respondToTaskHelp: vi.fn(async () => 'help sent'),
    decideTaskApproval: vi.fn(async () => 'decision sent'),
    sendTaskManualInput: vi.fn(async () => 'input sent'),
    quit: vi.fn(async () => {}),
  };
}

describe('parseSlashCommand', () => {
  it('parses quoted flag values', () => {
    expect(
      parseSlashCommand(
        '/feature-add --milestone m-1 --name "Planner TUI" --description "Command-first composer"',
      ),
    ).toEqual({
      name: 'feature-add',
      args: {
        milestone: 'm-1',
        name: 'Planner TUI',
        description: 'Command-first composer',
      },
    });
  });

  it('parses quoted positionals for split and merge commands', () => {
    expect(
      parseSlashCommand(
        '/feature-split --feature f-1 "api|API feature|API work" "ui|UI feature|UI work|api"',
      ),
    ).toEqual({
      name: 'feature-split',
      args: { feature: 'f-1' },
      positionals: ['api|API feature|API work', 'ui|UI feature|UI work|api'],
    });

    expect(
      parseSlashCommand('/feature-merge --name "Merged feature" f-1 f-2'),
    ).toEqual({
      name: 'feature-merge',
      args: { name: 'Merged feature' },
      positionals: ['f-1', 'f-2'],
    });
  });

  it('rejects non-slash input', () => {
    expect(() => parseSlashCommand('planner chat later')).toThrow(
      'slash command must start with "/"',
    );
  });

  it('parses init command args', () => {
    const parsed = parseSlashCommand(
      `/init ${INITIALIZE_PROJECT_EXAMPLE_COMMAND}`,
    );

    expect(parseInitializeProjectCommand(parsed)).toEqual({
      milestoneName: 'Milestone 1',
      milestoneDescription: 'Initial milestone',
      featureName: 'Project startup',
      featureDescription: 'Plan initial project work',
    });
  });
});

describe('handleComposerSubmit', () => {
  it('routes plain text through requestTopLevelPlan and records the notice', async () => {
    const addToHistory = vi.fn();
    const setNotice = vi.fn();
    const refresh = vi.fn();
    const requestTopLevelPlan = vi.fn(
      () => 'Queued top-level planning request.',
    );

    await handleComposerSubmit({
      text: 'plan the next milestone slice',
      executeSlashCommand: vi.fn(),
      requestTopLevelPlan,
      addToHistory,
      setNotice,
      refresh,
    });

    expect(requestTopLevelPlan).toHaveBeenCalledWith(
      'plan the next milestone slice',
    );
    expect(addToHistory).toHaveBeenCalledWith('plan the next milestone slice');
    expect(setNotice).toHaveBeenCalledWith(
      'Queued top-level planning request.',
    );
    expect(refresh).toHaveBeenCalled();
  });
});

describe('buildComposerSlashCommands', () => {
  it('suggests slash command names through pi-tui autocomplete', async () => {
    const provider = new CombinedAutocompleteProvider(
      buildComposerSlashCommands({
        snapshot: {
          milestones: [createMilestoneFixture()],
          features: [
            createFeatureFixture({ id: 'f-1', workControl: 'planning' }),
          ],
          tasks: [createTaskFixture()],
        },
        selection: { featureId: 'f-1', taskId: 't-1' },
      }),
    );

    const suggestions = await provider.getSuggestions(['/fea'], 0, 4, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items.map((item) => item.value)).toContain(
      'feature-add',
    );
    expect(suggestions?.items.map((item) => item.value)).toContain(
      'feature-edit',
    );
    expect(suggestions?.items.map((item) => item.value)).toContain(
      'feature-move',
    );
    expect(suggestions?.items.map((item) => item.value)).toContain(
      'feature-split',
    );
    expect(suggestions?.items.map((item) => item.value)).toContain(
      'feature-merge',
    );
  });

  it('completes task ids from current snapshot', async () => {
    const commands = buildComposerSlashCommands({
      snapshot: {
        milestones: [createMilestoneFixture()],
        features: [
          createFeatureFixture({ id: 'f-1', workControl: 'planning' }),
        ],
        tasks: [
          createTaskFixture({ id: 't-1', featureId: 'f-1' }),
          createTaskFixture({ id: 't-2', featureId: 'f-1', orderInFeature: 1 }),
        ],
      },
      selection: { featureId: 'f-1', taskId: 't-2' },
    });
    const editCommand = commands.find((entry) => entry.name === 'task-edit');
    const preserveCommand = commands.find(
      (entry) => entry.name === 'task-cancel-preserve',
    );
    const cleanCommand = commands.find(
      (entry) => entry.name === 'task-cancel-clean',
    );
    const configSetCommand = commands.find(
      (entry) => entry.name === 'config-set',
    );

    const editSuggestions =
      await editCommand?.getArgumentCompletions?.('--task t-');
    const preserveSuggestions =
      await preserveCommand?.getArgumentCompletions?.('');
    const cleanSuggestions = await cleanCommand?.getArgumentCompletions?.('');
    const configSuggestions =
      await configSetCommand?.getArgumentCompletions?.('');

    expect(editSuggestions).toContainEqual(
      expect.objectContaining({ value: '--task t-1 --description ""' }),
    );
    expect(editSuggestions).toContainEqual(
      expect.objectContaining({ value: '--task t-2 --description ""' }),
    );
    expect(preserveSuggestions).toContainEqual(
      expect.objectContaining({ value: '--task t-2' }),
    );
    expect(cleanSuggestions).toContainEqual(
      expect.objectContaining({ value: '--task t-2' }),
    );
    expect(configSuggestions).toContainEqual(
      expect.objectContaining({ value: '--key retryCap --value "7"' }),
    );
  });

  it('advertises split and reorder templates with current grammar', async () => {
    const commands = buildComposerSlashCommands({
      snapshot: {
        milestones: [createMilestoneFixture()],
        features: [
          createFeatureFixture({ id: 'f-1', workControl: 'planning' }),
        ],
        tasks: [
          createTaskFixture({ id: 't-1', featureId: 'f-1' }),
          createTaskFixture({ id: 't-2', featureId: 'f-1', orderInFeature: 1 }),
        ],
      },
      selection: { featureId: 'f-1' },
    });
    const splitCommand = commands.find(
      (entry) => entry.name === 'feature-split',
    );
    const reorderCommand = commands.find(
      (entry) => entry.name === 'task-reorder',
    );

    const splitSuggestions = await splitCommand?.getArgumentCompletions?.('');
    const reorderSuggestions =
      await reorderCommand?.getArgumentCompletions?.('');

    expect(splitSuggestions).toContainEqual(
      expect.objectContaining({
        value:
          '--feature f-1 "api|API feature|API work" "ui|UI feature|UI work|api"',
      }),
    );
    expect(reorderSuggestions).toContainEqual(
      expect.objectContaining({ value: '--feature f-1 t-1 t-2' }),
    );
  });

  it('uses selected milestone as default feature-add template', async () => {
    const commands = buildComposerSlashCommands({
      snapshot: {
        milestones: [createMilestoneFixture()],
        features: [
          createFeatureFixture({ id: 'f-1', workControl: 'planning' }),
        ],
        tasks: [],
      },
      selection: { milestoneId: 'm-1', featureId: 'f-1' },
    });
    const featureAddCommand = commands.find(
      (entry) => entry.name === 'feature-add',
    );
    const featureAbandonCommand = commands.find(
      (entry) => entry.name === 'feature-abandon',
    );

    const featureAddSuggestions =
      await featureAddCommand?.getArgumentCompletions?.('');
    const featureAbandonSuggestions =
      await featureAbandonCommand?.getArgumentCompletions?.('');

    expect(featureAddSuggestions).toContainEqual(
      expect.objectContaining({
        value: '--milestone m-1 --name "" --description ""',
      }),
    );
    expect(featureAbandonSuggestions).toContainEqual(
      expect.objectContaining({ value: '--feature f-1' }),
    );
  });

  it('completes milestone-add template', async () => {
    const command = buildComposerSlashCommands({
      snapshot: {
        milestones: [createMilestoneFixture()],
        features: [
          createFeatureFixture({ id: 'f-1', workControl: 'planning' }),
        ],
        tasks: [],
      },
      selection: { featureId: 'f-1' },
    }).find((entry) => entry.name === 'milestone-add');

    const suggestions = await command?.getArgumentCompletions?.('');

    expect(suggestions).toContainEqual(
      expect.objectContaining({
        value: '--name "" --description ""',
      }),
    );
  });

  it('routes task help, cancel, and approval commands through task runtime controls', async () => {
    const dataSource = createDataSource();
    const proposalController = {
      execute: vi.fn(async (input: string) => {
        if (input === '/approve' || input.startsWith('/reject')) {
          throw new Error('select feature with pending proposal first');
        }
        return { message: 'proposal handled' };
      }),
    };

    await expect(
      executeSlashCommand({
        input: '/reply --text "Use option B"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: proposalController as never,
        currentSelection: { taskId: 't-1' },
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('help sent');
    expect(dataSource.respondToTaskHelp).toHaveBeenCalledWith('t-1', {
      kind: 'answer',
      text: 'Use option B',
    });

    await expect(
      executeSlashCommand({
        input: '/task-cancel-preserve --task t-1',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: proposalController as never,
        currentSelection: { taskId: 't-1' },
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Cancelled t-1 and preserved its worktree.');
    expect(dataSource.cancelTaskPreserveWorktree).toHaveBeenCalledWith('t-1');

    await expect(
      executeSlashCommand({
        input: '/task-cancel-clean --task t-1',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: proposalController as never,
        currentSelection: { taskId: 't-1' },
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Cancelled t-1 and removed its worktree.');
    expect(dataSource.cancelTaskCleanWorktree).toHaveBeenCalledWith('t-1');

    const approvalSource = createDataSource(
      makeTaskRun({ runStatus: 'await_approval' }),
    );
    await expect(
      executeSlashCommand({
        input: '/approve',
        commandContext: {} as never,
        notice: undefined,
        dataSource: approvalSource,
        proposalController: proposalController as never,
        currentSelection: { taskId: 't-1' },
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('decision sent');
    expect(approvalSource.decideTaskApproval).toHaveBeenCalledWith('t-1', {
      kind: 'approved',
    });

    await expect(
      executeSlashCommand({
        input: '/input --text "continue"',
        commandContext: {} as never,
        notice: undefined,
        dataSource: approvalSource,
        proposalController: proposalController as never,
        currentSelection: { taskId: 't-1' },
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('input sent');
    expect(approvalSource.sendTaskManualInput).toHaveBeenCalledWith(
      't-1',
      'continue',
    );
  });

  it('routes inbox, transcript, merge-train, config, and feature-abandon commands through runtime controls', async () => {
    const dataSource = createDataSource();
    const toggleInbox = vi.fn();
    const toggleTranscript = vi.fn();
    const toggleMergeTrain = vi.fn();
    const toggleConfig = vi.fn();

    await expect(
      executeSlashCommand({
        input: '/inbox',
        commandContext: { toggleInbox } as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('toggled inbox');
    expect(toggleInbox).toHaveBeenCalledTimes(1);

    await expect(
      executeSlashCommand({
        input: '/transcript',
        commandContext: { toggleTranscript } as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('toggled transcript');
    expect(toggleTranscript).toHaveBeenCalledTimes(1);

    await expect(
      executeSlashCommand({
        input: '/merge-train',
        commandContext: { toggleMergeTrain } as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('toggled merge train');
    expect(toggleMergeTrain).toHaveBeenCalledTimes(1);

    await expect(
      executeSlashCommand({
        input: '/config',
        commandContext: { toggleConfig } as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('toggled config');
    expect(toggleConfig).toHaveBeenCalledTimes(1);

    await expect(
      executeSlashCommand({
        input: '/inbox-reply --id inbox-1 --text "Use option B"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('help sent');
    expect(dataSource.respondToInboxHelp).toHaveBeenCalledWith('inbox-1', {
      kind: 'answer',
      text: 'Use option B',
    });

    await expect(
      executeSlashCommand({
        input: '/inbox-approve --id inbox-2',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('decision sent');
    expect(dataSource.decideInboxApproval).toHaveBeenCalledWith('inbox-2', {
      kind: 'approved',
    });

    await expect(
      executeSlashCommand({
        input: '/inbox-reject --id inbox-3 --comment "Need another pass"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('decision sent');
    expect(dataSource.decideInboxApproval).toHaveBeenCalledWith('inbox-3', {
      kind: 'reject',
      comment: 'Need another pass',
    });

    await expect(
      executeSlashCommand({
        input: '/feature-abandon --feature f-2',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Abandoned f-2 and removed its branches/worktrees.');
    expect(dataSource.abandonFeatureBranch).toHaveBeenCalledWith('f-2');

    await expect(
      executeSlashCommand({
        input: '/merge-train-position --feature f-2 --position 3',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Set merge-train position for f-2 to 3.');
    expect(dataSource.setMergeTrainManualPosition).toHaveBeenCalledWith(
      'f-2',
      3,
    );

    await expect(
      executeSlashCommand({
        input: '/merge-train-position --feature f-2',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Cleared merge-train position for f-2.');
    expect(dataSource.setMergeTrainManualPosition).toHaveBeenCalledWith(
      'f-2',
      undefined,
    );
  });

  it('routes config-set through live config update', async () => {
    const dataSource = createDataSource();

    await expect(
      executeSlashCommand({
        input: '/config-set --key retryCap --value "7"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Updated retryCap to 7.');
    expect(dataSource.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ retryCap: 7 }),
    );

    await expect(
      executeSlashCommand({
        input:
          '/config-set --key models.verifier.model --value "claude-opus-4-7"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).resolves.toBe('Updated models.verifier.model to claude-opus-4-7.');
  });

  it('validates config-set input', async () => {
    const dataSource = createDataSource();

    await expect(
      executeSlashCommand({
        input: '/config-set --key nope --value "7"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).rejects.toThrow('--key must be one of:');

    await expect(
      executeSlashCommand({
        input: '/config-set --key retryCap',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).rejects.toThrow('--value is required');

    await expect(
      executeSlashCommand({
        input: '/config-set --key retryCap --value "0"',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).rejects.toThrow('retryCap must be a positive integer');
  });

  it('rejects invalid merge-train position commands', async () => {
    const dataSource = createDataSource();

    await expect(
      executeSlashCommand({
        input: '/merge-train-position --position 2',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).rejects.toThrow('--feature is required');

    await expect(
      executeSlashCommand({
        input: '/merge-train-position --feature f-2 --position 0',
        commandContext: {} as never,
        notice: undefined,
        dataSource,
        proposalController: { execute: vi.fn() } as never,
        currentSelection: {},
        setSelectedNodeId: vi.fn(),
      }),
    ).rejects.toThrow('--position must be a positive integer');
  });
});

describe('tui overlay helpers', () => {
  it('marks transcript as a visible overlay', () => {
    expect(
      hasVisibleOverlay({
        helpHandle: undefined,
        monitorHandle: undefined,
        dependencyHandle: undefined,
        inboxHandle: undefined,
        mergeTrainHandle: undefined,
        configHandle: undefined,
        transcriptHandle: { hide: vi.fn() } as never,
      }),
    ).toBe(true);
  });

  it('rate-caps worker output refreshes by interval', () => {
    expect(shouldRenderAfterWorkerOutput(100, 150, 100)).toBe(false);
    expect(shouldRenderAfterWorkerOutput(100, 200, 100)).toBe(true);
    expect(shouldRenderAfterWorkerOutput(100, 250, 100)).toBe(true);
  });
});
