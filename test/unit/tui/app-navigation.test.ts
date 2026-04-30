import { handleGraphInput } from '@tui/app-navigation';
import type {
  TuiCommand,
  TuiCommandContext,
  TuiCommandKey,
} from '@tui/commands/index';
import { describe, expect, it, vi } from 'vitest';

const ESC = '\x1b';

interface HarnessOptions {
  focusMode?: 'composer' | 'graph';
  hasVisibleOverlay?: boolean;
  overlayHidden?: boolean;
  commands?: readonly TuiCommand[];
}

function createHarness(options: HarnessOptions = {}) {
  const focusGraph = vi.fn();
  const focusComposer = vi.fn();
  const moveSelection = vi.fn();
  const hideTopOverlay = vi.fn(() => options.overlayHidden ?? false);
  const executeByKey = vi.fn((_key: TuiCommandKey, _ctx: TuiCommandContext) =>
    Promise.resolve(true),
  );

  const commandContext = {} as TuiCommandContext;
  const commands = options.commands ?? [];

  function send(data: string): boolean {
    return handleGraphInput({
      data,
      focusMode: options.focusMode ?? 'composer',
      hasVisibleOverlay: options.hasVisibleOverlay ?? false,
      hideTopOverlay,
      focusGraph,
      focusComposer,
      moveSelection,
      commands,
      commandContext,
      executeByKey,
    });
  }

  return {
    send,
    focusGraph,
    focusComposer,
    moveSelection,
    hideTopOverlay,
    executeByKey,
  };
}

describe('handleGraphInput overlay precedence', () => {
  it('hides overlay before changing focus on esc from composer', () => {
    const h = createHarness({
      focusMode: 'composer',
      hasVisibleOverlay: true,
      overlayHidden: true,
    });

    expect(h.send(ESC)).toBe(true);
    expect(h.hideTopOverlay).toHaveBeenCalledTimes(1);
    expect(h.focusGraph).not.toHaveBeenCalled();
    expect(h.focusComposer).not.toHaveBeenCalled();
  });

  it('hides overlay before changing focus on esc from graph', () => {
    const h = createHarness({
      focusMode: 'graph',
      hasVisibleOverlay: true,
      overlayHidden: true,
    });

    expect(h.send(ESC)).toBe(true);
    expect(h.hideTopOverlay).toHaveBeenCalledTimes(1);
    expect(h.focusGraph).not.toHaveBeenCalled();
    expect(h.focusComposer).not.toHaveBeenCalled();
  });

  it('q hides overlay when overlay is open', () => {
    const h = createHarness({
      focusMode: 'graph',
      hasVisibleOverlay: true,
      overlayHidden: true,
    });

    expect(h.send('q')).toBe(true);
    expect(h.hideTopOverlay).toHaveBeenCalledTimes(1);
  });
});

describe('handleGraphInput focus toggle', () => {
  it('esc from composer (no overlay) switches to graph', () => {
    const h = createHarness({ focusMode: 'composer' });

    expect(h.send(ESC)).toBe(true);
    expect(h.focusGraph).toHaveBeenCalledTimes(1);
    expect(h.focusComposer).not.toHaveBeenCalled();
  });

  it('esc from graph (no overlay) switches back to composer', () => {
    const h = createHarness({ focusMode: 'graph' });

    expect(h.send(ESC)).toBe(true);
    expect(h.focusComposer).toHaveBeenCalledTimes(1);
    expect(h.focusGraph).not.toHaveBeenCalled();
  });

  it('esc from composer switches to graph regardless of composer text', () => {
    const h = createHarness({ focusMode: 'composer' });

    expect(h.send(ESC)).toBe(true);
    expect(h.focusGraph).toHaveBeenCalledTimes(1);
  });
});

describe('handleGraphInput slash seeding', () => {
  it('/ from graph focus moves to composer with seed', () => {
    const h = createHarness({ focusMode: 'graph' });

    expect(h.send('/')).toBe(true);
    expect(h.focusComposer).toHaveBeenCalledWith('/');
  });

  it('/ from composer focus does not seed (composer handles it directly)', () => {
    const h = createHarness({ focusMode: 'composer' });

    expect(h.send('/')).toBe(false);
    expect(h.focusComposer).not.toHaveBeenCalled();
  });
});

describe('handleGraphInput command dispatch', () => {
  it('routes single-key commands in graph focus', async () => {
    const command: TuiCommand = {
      name: 'queue_milestone',
      key: 'g',
      label: 'queue',
      description: 'queue',
      execute: () => Promise.resolve(),
    };
    const h = createHarness({ focusMode: 'graph', commands: [command] });

    expect(h.send('g')).toBe(true);
    expect(h.executeByKey).toHaveBeenCalledTimes(1);
    expect(h.executeByKey.mock.calls[0]?.[0]).toBe('g');
  });

  it('does not dispatch commands while composer is focused', () => {
    const command: TuiCommand = {
      name: 'queue_milestone',
      key: 'g',
      label: 'queue',
      description: 'queue',
      execute: () => Promise.resolve(),
    };
    const h = createHarness({ focusMode: 'composer', commands: [command] });

    expect(h.send('g')).toBe(false);
    expect(h.executeByKey).not.toHaveBeenCalled();
  });
});
