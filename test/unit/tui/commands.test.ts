import { CombinedAutocompleteProvider } from '@mariozechner/pi-tui';
import {
  buildComposerSlashCommands,
  INITIALIZE_PROJECT_EXAMPLE_COMMAND,
  parseInitializeProjectCommand,
  parseSlashCommand,
} from '@tui/commands/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

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
});
