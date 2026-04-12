import { describe, expect, it, vi } from 'vitest';

import { TuiApp } from '../../../src/tui/app.js';
import { CommandRegistry } from '../../../src/tui/commands/index.js';
import { DagView, StatusBar } from '../../../src/tui/components/index.js';
import { TuiViewModelBuilder } from '../../../src/tui/view-model/index.js';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

describe('TuiViewModelBuilder', () => {
  it('builds a milestone tree with nested features and tasks', () => {
    const builder = new TuiViewModelBuilder();
    const milestones = [createMilestoneFixture({ id: 'm-1', name: 'MVP' })];
    const features = [
      createFeatureFixture({ id: 'f-1', milestoneId: 'm-1', name: 'Auth' }),
    ];
    const tasks = [
      createTaskFixture({
        id: 't-1',
        featureId: 'f-1',
        description: 'Login page',
      }),
    ];

    const tree = builder.buildMilestoneTree(milestones, features, tasks);

    expect(tree.length).toBe(1);
    expect(tree[0]!.label).toContain('MVP');
    expect(tree[0]!.children.length).toBe(1);
    expect(tree[0]!.children[0]!.label).toContain('Auth');
    expect(tree[0]!.children[0]!.children.length).toBe(1);
  });

  it('returns passthrough status bar data', () => {
    const builder = new TuiViewModelBuilder();
    const bar = builder.buildStatusBar({
      runningWorkers: 2,
      idleWorkers: 2,
      completedTasks: 5,
      totalTasks: 10,
      totalUsd: 1.5,
    });

    expect(bar.runningWorkers).toBe(2);
    expect(bar.completedTasks).toBe(5);
    expect(bar.totalUsd).toBe(1.5);
  });
});

describe('DagView', () => {
  it('renders at least one line for a non-zero width', () => {
    const view = new DagView();
    const lines = view.render(80);

    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('StatusBar', () => {
  it('renders at least one line', () => {
    const bar = new StatusBar();
    const lines = bar.render(80);

    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('CommandRegistry', () => {
  it('returns registered commands', () => {
    const cmd = {
      name: 'toggle_auto' as const,
      execute: vi.fn(async () => {}),
    };
    const registry = new CommandRegistry([cmd]);

    const all = registry.getAll();

    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('toggle_auto');
  });

  it('returns empty for no commands', () => {
    const registry = new CommandRegistry();
    expect(registry.getAll()).toHaveLength(0);
  });
});

describe('TuiApp', () => {
  it('show() blocks until dispose() resolves it', async () => {
    const frames: string[][] = [];
    const app = new TuiApp({ writeFrame: (lines) => frames.push(lines) });

    const started = app.show();
    await new Promise((resolve) => setTimeout(resolve, 5));
    app.refresh();
    app.dispose();
    await started;

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.some((line) => line.includes('DAG'))).toBe(true);
  });
});
