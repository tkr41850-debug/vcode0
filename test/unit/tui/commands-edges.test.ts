import {
  buildComposerSlashCommands,
  parseSlashCommand,
} from '@tui/commands/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

describe('parseSlashCommand edge cases', () => {
  it('bare flag (no value) becomes boolean true', () => {
    expect(parseSlashCommand('/foo --verbose')).toEqual({
      name: 'foo',
      args: { verbose: true },
    });
  });

  it('flag followed by another flag', () => {
    expect(parseSlashCommand('/foo --a --b val')).toEqual({
      name: 'foo',
      args: { a: true, b: 'val' },
    });
  });

  it('positionals collected separately', () => {
    expect(parseSlashCommand('/foo bar baz --flag value')).toEqual({
      name: 'foo',
      args: { flag: 'value' },
      positionals: ['bar', 'baz'],
    });
  });

  it('empty command name throws', () => {
    expect(() => parseSlashCommand('/')).toThrow('slash command name missing');
  });

  it('leading/trailing whitespace tolerated', () => {
    expect(parseSlashCommand('   /foo --x y   ')).toEqual({
      name: 'foo',
      args: { x: 'y' },
    });
  });
});

describe('buildComposerSlashCommands edge cases', () => {
  it('empty snapshot returns commands without id options', () => {
    const result = buildComposerSlashCommands({
      snapshot: { milestones: [], features: [], tasks: [] },
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => typeof c.name === 'string')).toBe(true);
  });

  it('selection.featureId is preferred over inferring from taskId', () => {
    const result = buildComposerSlashCommands({
      snapshot: {
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [createFeatureFixture({ id: 'f-1', milestoneId: 'm-1' })],
        tasks: [createTaskFixture({ id: 't-1', featureId: 'f-2' })],
      },
      selection: { featureId: 'f-1', taskId: 't-1' },
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => typeof c.name === 'string')).toBe(true);
  });
});
