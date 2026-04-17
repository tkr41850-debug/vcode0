import { CombinedAutocompleteProvider } from '@mariozechner/pi-tui';
import type { TaskAgentRun } from '@core/types/index';
import { executeSlashCommand } from '@tui/app-composer';
import {
  buildComposerSlashCommands,
  INITIALIZE_PROJECT_EXAMPLE_COMMAND,
  parseInitializeProjectCommand,
  parseSlashCommand,
} from '@tui/commands/index';
import { describe, expect, it, vi } from 'vitest';

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

function createDataSource(taskRun?: TaskAgentRun) {
  return {
    snapshot: () => ({ milestones: [], features: [], tasks: [] }),
    listAgentRuns: () => [],
    getWorkerCounts: () => ({ runningWorkers: 0, idleWorkers: 0, totalWorkers: 0 }),
    isAutoExecutionEnabled: () => true,
    setAutoExecutionEnabled: () => true,
    toggleAutoExecution: () => true,
    initializeProject: vi.fn(),
    toggleMilestoneQueue: vi.fn(),
    cancelFeature: vi.fn(),
    saveFeatureRun: vi.fn(),
    getFeatureRun: vi.fn(),
    getTaskRun: vi.fn(() => taskRun),
    enqueueApprovalDecision: vi.fn(),
    rerunFeatureProposal: vi.fn(),
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
  });

  it('completes task ids from current snapshot', async () => {
    const command = buildComposerSlashCommands({
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
    }).find((entry) => entry.name === 'task-edit');

    const suggestions = await command?.getArgumentCompletions?.('--task t-');

    expect(suggestions).toContainEqual(
      expect.objectContaining({ value: '--task t-1 --description ""' }),
    );
    expect(suggestions).toContainEqual(
      expect.objectContaining({ value: '--task t-2 --description ""' }),
    );
  });

  it('uses selected milestone as default feature-add template', async () => {
    const command = buildComposerSlashCommands({
      snapshot: {
        milestones: [createMilestoneFixture()],
        features: [
          createFeatureFixture({ id: 'f-1', workControl: 'planning' }),
        ],
        tasks: [],
      },
      selection: { milestoneId: 'm-1' },
    }).find((entry) => entry.name === 'feature-add');

    const suggestions = await command?.getArgumentCompletions?.('');

    expect(suggestions).toContainEqual(
      expect.objectContaining({
        value: '--milestone m-1 --name "" --description ""',
      }),
    );
  });

  it('routes task help and approval commands through task runtime controls', async () => {
    const dataSource = createDataSource();
    const proposalController = { execute: vi.fn() };

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
});
