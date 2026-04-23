import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { Feature, GvcConfig, Task } from '@core/types/index';
import { defaultTaskBranch } from '@orchestrator/conflicts/helpers';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFeatureFixture,
  createTaskFixture,
  updateTask,
} from '../../helpers/graph-builders.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createPorts(root: string): OrchestratorPorts {
  return {
    store: {} as OrchestratorPorts['store'],
    agents: {} as OrchestratorPorts['agents'],
    verification: {} as OrchestratorPorts['verification'],
    worktree: {
      ensureFeatureWorktree: () => Promise.resolve(root),
      ensureTaskWorktree: () => Promise.resolve(root),
    },
    ui: {} as OrchestratorPorts['ui'],
    sessionStore: new InMemorySessionStore(),
    config: createConfig(),
    runtime: {
      dispatchTask: vi.fn(),
      steerTask: vi.fn((taskId: string) =>
        Promise.resolve({
          kind: 'delivered' as const,
          taskId,
          agentRunId: `run-${taskId}`,
        }),
      ),
      suspendTask: vi.fn((taskId: string) =>
        Promise.resolve({
          kind: 'delivered' as const,
          taskId,
          agentRunId: `run-${taskId}`,
        }),
      ),
      resumeTask: vi.fn((taskId: string) =>
        Promise.resolve({
          kind: 'delivered' as const,
          taskId,
          agentRunId: `run-${taskId}`,
        }),
      ),
      respondToHelp: vi.fn((taskId: string) =>
        Promise.resolve({ kind: 'not_running' as const, taskId }),
      ),
      decideApproval: vi.fn((taskId: string) =>
        Promise.resolve({ kind: 'not_running' as const, taskId }),
      ),
      sendManualInput: vi.fn((taskId: string) =>
        Promise.resolve({ kind: 'not_running' as const, taskId }),
      ),
      abortTask: vi.fn(),
      respondClaim: vi.fn((taskId: string) =>
        Promise.resolve({ kind: 'not_running' as const, taskId }),
      ),
      idleWorkerCount: vi.fn(() => 0),
      stopAll: vi.fn(),
    },
  } as OrchestratorPorts & {
    runtime: {
      suspendTask: ReturnType<typeof vi.fn>;
      resumeTask: ReturnType<typeof vi.fn>;
      steerTask: ReturnType<typeof vi.fn>;
    };
  };
}

function createFeature(overrides: Partial<Feature> = {}): Feature {
  return createFeatureFixture({
    id: 'f-feature-1',
    name: 'Feature 1',
    featureBranch: 'feat-feature-1-1',
    collabControl: 'branch_open',
    workControl: 'executing',
    ...overrides,
  });
}

function createTask(overrides: Partial<Task> = {}): Task {
  return createTaskFixture({
    featureId: 'f-feature-1',
    status: 'running',
    collabControl: 'branch_open',
    ...overrides,
  });
}

function createGraph(): InMemoryFeatureGraph {
  const graph = new InMemoryFeatureGraph();
  graph.createMilestone({ id: 'm-1', name: 'M1', description: 'd' });
  graph.createMilestone({ id: 'm-2', name: 'M2', description: 'd' });
  graph.createFeature({
    id: 'f-feature-1',
    milestoneId: 'm-1',
    name: 'Feature 1',
    description: 'desc',
  });
  graph.createFeature({
    id: 'f-feature-2',
    milestoneId: 'm-2',
    name: 'Feature 2',
    description: 'desc',
  });
  graph.createTask({
    id: 't-feature-2-running',
    featureId: 'f-feature-2',
    description: 'Task 1',
  });
  graph.createTask({
    id: 't-feature-2-ready',
    featureId: 'f-feature-2',
    description: 'Task 2',
  });
  return graph;
}

async function git(dir: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error('git command failed'),
        );
        return;
      }
      resolve();
    });
  });
}

async function gitOutput(dir: string, ...args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error, stdout) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error('git command failed'),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'base\n');
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Test User');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'add', 'README.md', '.gitignore');
  await git(dir, 'commit', '-m', 'init');
}

async function writeTaskRebaseRepo(
  root: string,
  feature: Feature,
  taskBranch: string,
): Promise<string> {
  const taskDir = path.join(root, worktreePath(taskBranch));
  await initRepo(taskDir);
  await git(taskDir, 'checkout', '-b', feature.featureBranch);
  await fs.mkdir(path.join(taskDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'base\n');
  await git(taskDir, 'add', 'src/a.ts');
  await git(taskDir, 'commit', '-m', 'feature base');
  await git(taskDir, 'checkout', '-b', taskBranch);
  return taskDir;
}

async function writeFeatureRebaseRepo(
  root: string,
  feature: Feature,
): Promise<string> {
  const featureDir = path.join(root, worktreePath(feature.featureBranch));
  await initRepo(featureDir);
  await fs.mkdir(path.join(featureDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'base\n');
  await git(featureDir, 'add', 'src/a.ts');
  await git(featureDir, 'commit', '-m', 'shared base');
  await git(featureDir, 'checkout', '-b', feature.featureBranch);
  return featureDir;
}

describe('conflict helper naming', () => {
  it('prefers stored worktree branch but preserves legacy fallback when absent', () => {
    expect(
      defaultTaskBranch(
        createTaskFixture({
          id: 't-feature-2-running',
          featureId: 'f-feature-2',
          worktreeBranch: 'feat-feature-2-2-running',
        }),
      ),
    ).toBe('feat-feature-2-2-running');
    expect(
      defaultTaskBranch(
        createTaskFixture({
          id: 't-feature-2-running',
          featureId: 'f-feature-2',
        }),
      ),
    ).toBe('feat-f-feature-2-task-t-feature-2-running');
  });
});

describe('ConflictCoordinator', () => {
  const getTmpDir = useTmpDir('orchestrator-conflicts');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(getTmpDir());
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('suspends lower-priority overlapping tasks and persists suspension metadata', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [createFeature({ milestoneId: 'm-1', status: 'in_progress' })],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTask({
          id: 't-secondary',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-secondary',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const feature = graph.features.get('f-feature-1');
    const dominant = graph.tasks.get('t-dominant');
    const secondary = graph.tasks.get('t-secondary');

    assert(
      feature !== undefined &&
        dominant !== undefined &&
        secondary !== undefined,
      'missing fixture state',
    );

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: [dominant.id, secondary.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, secondary],
    );

    expect(graph.tasks.get('t-secondary')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-secondary')?.suspendedAt).toEqual(
      expect.any(Number),
    );
    expect(ports.runtime.suspendTask).toHaveBeenCalledWith(
      secondary.id,
      'same_feature_overlap',
      ['src/a.ts'],
    );
    expect(ports.runtime.suspendTask).not.toHaveBeenCalledWith(
      dominant.id,
      'same_feature_overlap',
      ['src/a.ts'],
    );
  });

  it('rebases suspended task cleanly and resumes it', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
          result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
        }),
        createTask({
          id: 't-suspended',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-suspended',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const suspended = graph.tasks.get('t-suspended');
    const dominant = graph.tasks.get('t-dominant');

    assert(
      suspended !== undefined &&
        suspended.worktreeBranch !== undefined &&
        dominant !== undefined,
      'missing suspended task',
    );

    const taskDir = await writeTaskRebaseRepo(
      root,
      feature,
      suspended.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task branch\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');
    await git(taskDir, 'checkout', feature.featureBranch);
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'feature update\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'feature update');
    await git(taskDir, 'checkout', suspended.worktreeBranch);

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: ['t-dominant', suspended.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, suspended],
    );
    await coordinator.reconcileSameFeatureTasks(feature.id, 't-dominant');

    expect(graph.tasks.get('t-suspended')).toMatchObject({
      collabControl: 'branch_open',
      status: 'running',
    });
    expect(graph.tasks.get('t-suspended')?.suspendReason).toBeUndefined();
    expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
      suspended.id,
      'same_feature_rebase',
    );
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
    await expect(
      gitOutput(taskDir, 'rev-parse', '--verify', 'REBASE_HEAD'),
    ).rejects.toBeDefined();
  }, 20000);

  it('transitions task to conflict and steers it when rebase conflicts', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
          result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
        }),
        createTask({
          id: 't-suspended',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-suspended-conflict',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const suspended = graph.tasks.get('t-suspended');
    const dominant = graph.tasks.get('t-dominant');

    assert(
      suspended !== undefined &&
        suspended.worktreeBranch !== undefined &&
        dominant !== undefined,
      'missing suspended task',
    );

    const taskDir = await writeTaskRebaseRepo(
      root,
      feature,
      suspended.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'task change\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'task change');
    await git(taskDir, 'checkout', feature.featureBranch);
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'feature change\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'feature change');
    await git(taskDir, 'checkout', suspended.worktreeBranch);

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: ['t-dominant', suspended.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, suspended],
    );
    await coordinator.reconcileSameFeatureTasks(feature.id, 't-dominant');

    expect(graph.tasks.get('t-suspended')).toMatchObject({
      collabControl: 'conflict',
      status: 'running',
    });
    const steerDirective = vi.mocked(ports.runtime.steerTask).mock
      .calls[0]?.[1];
    expect(steerDirective).toMatchObject({
      kind: 'conflict_steer',
      timing: 'immediate',
    });
    assert(
      steerDirective?.kind === 'conflict_steer',
      'expected conflict_steer directive',
    );
    expect(steerDirective.gitConflictContext).toMatchObject({
      kind: 'same_feature_task_rebase',
      taskId: suspended.id,
      featureId: feature.id,
      files: ['src/a.ts'],
      conflictedFiles: ['src/a.ts'],
      pauseReason: 'same_feature_overlap',
      dominantTaskId: 't-dominant',
      dominantTaskSummary: 'dominant landed',
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
  }, 20000);

  it('leaves task suspended when worktree is missing during reconcile', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
        }),
        createTask({
          id: 't-suspended',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-missing',
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const suspended = graph.tasks.get('t-suspended');
    const dominant = graph.tasks.get('t-dominant');

    assert(
      suspended !== undefined && dominant !== undefined,
      'missing suspended task',
    );

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: ['t-dominant', suspended.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, suspended],
    );
    await coordinator.reconcileSameFeatureTasks(feature.id, 't-dominant');

    expect(graph.tasks.get('t-suspended')).toMatchObject({
      collabControl: 'suspended',
      status: 'running',
      suspendReason: 'same_feature_overlap',
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
  });

  it('keeps task suspended when resume delivery fails after clean rebase', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    ports.runtime.resumeTask = vi.fn((taskId: string) =>
      Promise.resolve({
        kind: 'not_running' as const,
        taskId,
      }),
    );
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTask({
          id: 't-suspended',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-not-running',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const suspended = graph.tasks.get('t-suspended');
    const dominant = graph.tasks.get('t-dominant');

    assert(
      suspended !== undefined &&
        suspended.worktreeBranch !== undefined &&
        dominant !== undefined,
      'missing suspended task',
    );

    const taskDir = await writeTaskRebaseRepo(
      root,
      feature,
      suspended.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task branch\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');
    await git(taskDir, 'checkout', feature.featureBranch);
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'feature update\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'feature update');
    await git(taskDir, 'checkout', suspended.worktreeBranch);

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: ['t-dominant', suspended.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, suspended],
    );
    await coordinator.reconcileSameFeatureTasks(feature.id, 't-dominant');

    expect(graph.tasks.get('t-suspended')).toMatchObject({
      collabControl: 'branch_open',
      status: 'ready',
    });
    expect(graph.tasks.get('t-suspended')?.suspendReason).toBeUndefined();
    expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
      suspended.id,
      'same_feature_rebase',
    );
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
  }, 20000);

  it('reconciles only suspended tasks blocked by landed dominant files', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
          result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
        }),
        createTask({
          id: 't-overlap',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-overlap',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTask({
          id: 't-unrelated',
          orderInFeature: 2,
          worktreeBranch: 'feat-feature-1-1-unrelated',
          reservedWritePaths: ['src/b.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const dominant = graph.tasks.get('t-dominant');
    const overlap = graph.tasks.get('t-overlap');

    assert(
      dominant !== undefined &&
        overlap !== undefined &&
        overlap.worktreeBranch !== undefined,
      'missing overlap fixture state',
    );

    const overlapDir = await writeTaskRebaseRepo(
      root,
      feature,
      overlap.worktreeBranch,
    );
    await fs.writeFile(path.join(overlapDir, 'src', 'c.ts'), 'task branch\n');
    await git(overlapDir, 'add', 'src/c.ts');
    await git(overlapDir, 'commit', '-m', 'task work');
    await git(overlapDir, 'checkout', feature.featureBranch);
    await fs.writeFile(
      path.join(overlapDir, 'src', 'a.ts'),
      'feature update\n',
    );
    await git(overlapDir, 'add', 'src/a.ts');
    await git(overlapDir, 'commit', '-m', 'feature update');
    await git(overlapDir, 'checkout', overlap.worktreeBranch);

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: [dominant.id, overlap.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, overlap],
    );
    graph.transitionTask('t-unrelated', {
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedAt: Date.now(),
      suspendedFiles: ['src/b.ts'],
    });

    await coordinator.reconcileSameFeatureTasks(feature.id, dominant.id);

    expect(graph.tasks.get('t-overlap')).toMatchObject({
      collabControl: 'branch_open',
      status: 'running',
    });
    expect(graph.tasks.get('t-unrelated')).toMatchObject({
      collabControl: 'suspended',
      status: 'running',
      suspendReason: 'same_feature_overlap',
      suspendedFiles: ['src/b.ts'],
    });
    expect(ports.runtime.resumeTask).toHaveBeenCalledTimes(1);
    expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
      't-overlap',
      'same_feature_rebase',
    );
    expect(ports.runtime.resumeTask).not.toHaveBeenCalledWith(
      't-unrelated',
      'same_feature_rebase',
    );
  }, 20000);

  it('ignores cancelled suspended tasks during same-feature reconcile', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
          result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
        }),
        createTask({
          id: 't-cancelled',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-cancelled',
          reservedWritePaths: ['src/a.ts'],
          status: 'cancelled',
          collabControl: 'suspended',
          suspendReason: 'same_feature_overlap',
          suspendedAt: 100,
          suspendedFiles: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);

    await coordinator.reconcileSameFeatureTasks(feature.id, 't-dominant');

    expect(graph.tasks.get('t-cancelled')).toMatchObject({
      status: 'cancelled',
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
  });

  it('steers suspended task when dirty worktree blocks same-feature rebase', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
          result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
        }),
        createTask({
          id: 't-suspended',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-dirty',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const dominant = graph.tasks.get('t-dominant');
    const suspended = graph.tasks.get('t-suspended');

    assert(
      dominant !== undefined &&
        suspended !== undefined &&
        suspended.worktreeBranch !== undefined,
      'missing dirty fixture state',
    );

    const taskDir = await writeTaskRebaseRepo(
      root,
      feature,
      suspended.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'dirty local edit\n');

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: [dominant.id, suspended.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, suspended],
    );
    await coordinator.reconcileSameFeatureTasks(feature.id, dominant.id);

    expect(graph.tasks.get('t-suspended')).toMatchObject({
      collabControl: 'conflict',
      status: 'running',
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    const dirtySteerDirective = vi.mocked(ports.runtime.steerTask).mock
      .calls[0]?.[1];
    expect(dirtySteerDirective).toMatchObject({
      kind: 'conflict_steer',
      timing: 'immediate',
    });
    assert(
      dirtySteerDirective?.kind === 'conflict_steer',
      'expected conflict_steer directive',
    );
    expect(dirtySteerDirective.gitConflictContext).toMatchObject({
      kind: 'same_feature_task_rebase',
      conflictedFiles: ['src/a.ts'],
      files: ['src/a.ts'],
    });
  }, 20000);

  it('matches dominant changed files after normalizing path variants', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const feature = createFeature({
      milestoneId: 'm-1',
      status: 'in_progress',
    });
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [feature],
      tasks: [
        createTask({
          id: 't-dominant',
          orderInFeature: 0,
          worktreeBranch: 'feat-feature-1-1-dominant',
          reservedWritePaths: ['src/a.ts'],
          result: { summary: 'dominant landed', filesChanged: ['./src/a.ts'] },
        }),
        createTask({
          id: 't-suspended',
          orderInFeature: 1,
          worktreeBranch: 'feat-feature-1-1-normalized',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const dominant = graph.tasks.get('t-dominant');
    const suspended = graph.tasks.get('t-suspended');

    assert(
      dominant !== undefined &&
        suspended !== undefined &&
        suspended.worktreeBranch !== undefined,
      'missing normalized fixture state',
    );

    const taskDir = await writeTaskRebaseRepo(
      root,
      feature,
      suspended.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task branch\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');
    await git(taskDir, 'checkout', feature.featureBranch);
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'feature update\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'feature update');
    await git(taskDir, 'checkout', suspended.worktreeBranch);

    await coordinator.handleSameFeatureOverlap(
      feature,
      {
        featureId: feature.id,
        taskIds: [dominant.id, suspended.id],
        files: ['src/a.ts'],
        suspendReason: 'same_feature_overlap',
      },
      [dominant, suspended],
    );
    await coordinator.reconcileSameFeatureTasks(feature.id, dominant.id);

    expect(graph.tasks.get('t-suspended')).toMatchObject({
      collabControl: 'branch_open',
      status: 'running',
    });
    expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
      suspended.id,
      'same_feature_rebase',
    );
  }, 20000);

  it('persists runtime feature blocking and suspends only running secondary tasks', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
      reservedWritePaths: ['src/a.ts'],
    });
    updateTask(graph, 't-feature-2-ready', {
      status: 'ready',
      collabControl: 'branch_open',
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');
    const readyTask = graph.tasks.get('t-feature-2-ready');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined &&
        readyTask !== undefined,
      'missing graph fixture state',
    );

    await coordinator.handleCrossFeatureOverlap(
      primary,
      secondary,
      [runningTask, readyTask],
      ['src/a.ts'],
    );

    expect(graph.features.get('f-feature-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-feature-1',
    });
    expect(graph.features.get('f-feature-2')?.dependsOn).not.toContain(
      'f-feature-1',
    );
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-feature-1',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-feature-2-running')?.suspendedAt).toEqual(
      expect.any(Number),
    );
    expect(graph.tasks.get('t-feature-2-ready')).toMatchObject({
      status: 'ready',
      collabControl: 'branch_open',
    });
    expect(ports.runtime.suspendTask).toHaveBeenCalledTimes(1);
    expect(ports.runtime.suspendTask).toHaveBeenCalledWith(
      't-feature-2-running',
      'cross_feature_overlap',
      ['src/a.ts'],
    );
  });

  it('rebases blocked secondary feature and resumes suspended tasks after primary lands', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
      worktreeBranch: 'feat-feature-2-2-task-running',
      reservedWritePaths: ['src/a.ts'],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined &&
        runningTask.worktreeBranch !== undefined,
      'missing graph fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, secondary);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', secondary.featureBranch);

    const taskDir = path.join(root, worktreePath(runningTask.worktreeBranch));
    await git(
      featureDir,
      'worktree',
      'add',
      taskDir,
      '-b',
      runningTask.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task work\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    const results = await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(results).toEqual([
      {
        featureId: secondary.id,
        blockedByFeatureId: primary.id,
        kind: 'resumed',
      },
    ]);
    expect(
      graph.features.get('f-feature-2')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      collabControl: 'branch_open',
      status: 'running',
    });
    expect(
      graph.tasks.get('t-feature-2-running')?.blockedByFeatureId,
    ).toBeUndefined();
    expect(
      graph.tasks.get('t-feature-2-running')?.suspendReason,
    ).toBeUndefined();
    expect(graph.tasks.get('t-feature-2-running')?.suspendedAt).toBeUndefined();
    expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
      't-feature-2-running',
      'cross_feature_rebase',
    );
  }, 20000);

  it('aborts failed secondary feature rebase before reporting repair_needed', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
      worktreeBranch: 'feat-feature-2-2-task-running',
      reservedWritePaths: ['src/a.ts'],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined,
      'missing graph fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, secondary);
    await git(featureDir, 'checkout', secondary.featureBranch);
    await fs.writeFile(
      path.join(featureDir, 'src', 'a.ts'),
      'feature change\n',
    );
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'feature change');
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main change\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main change');
    await git(featureDir, 'checkout', secondary.featureBranch);

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    const results = await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(results).toEqual([
      {
        featureId: secondary.id,
        blockedByFeatureId: primary.id,
        kind: 'repair_needed',
        conflictedFiles: ['src/a.ts'],
      },
    ]);
    expect(graph.features.get('f-feature-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-feature-1',
    });
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      collabControl: 'suspended',
      status: 'running',
      blockedByFeatureId: 'f-feature-1',
      suspendReason: 'cross_feature_overlap',
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    await expect(
      gitOutput(featureDir, 'rev-parse', '--verify', 'REBASE_HEAD'),
    ).rejects.toBeDefined();
    await expect(gitOutput(featureDir, 'status', '--porcelain')).resolves.toBe(
      '',
    );
  }, 20000);

  it('marks task ready when runtime resume delivery fails after clean cross-feature rebase', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    ports.runtime.resumeTask = vi.fn((taskId: string) =>
      Promise.resolve({
        kind: 'not_running' as const,
        taskId,
      }),
    );
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
      worktreeBranch: 'feat-feature-2-2-task-running',
      reservedWritePaths: ['src/a.ts'],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined &&
        runningTask.worktreeBranch !== undefined,
      'missing graph fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, secondary);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', secondary.featureBranch);

    const taskDir = path.join(root, worktreePath(runningTask.worktreeBranch));
    await git(
      featureDir,
      'worktree',
      'add',
      taskDir,
      '-b',
      runningTask.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task work\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    const results = await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(results).toEqual([
      {
        featureId: secondary.id,
        blockedByFeatureId: primary.id,
        kind: 'resumed',
      },
    ]);
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      status: 'ready',
      collabControl: 'branch_open',
    });
    expect(
      graph.tasks.get('t-feature-2-running')?.blockedByFeatureId,
    ).toBeUndefined();
    expect(
      graph.tasks.get('t-feature-2-running')?.suspendReason,
    ).toBeUndefined();
  }, 20000);

  it('reports blocked release when secondary feature worktree is missing', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined,
      'missing graph fixture state',
    );

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    const results = await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(results).toEqual([
      {
        featureId: secondary.id,
        blockedByFeatureId: primary.id,
        kind: 'blocked',
        summary: `Feature worktree missing for ${secondary.id}`,
      },
    ]);
    expect(graph.features.get('f-feature-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-feature-1',
    });
  });

  it('re-blocks feature when cross-feature task rebase conflicts after clean feature rebase', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
      worktreeBranch: 'feat-feature-2-2-task-running',
      reservedWritePaths: ['src/a.ts'],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined &&
        runningTask.worktreeBranch !== undefined,
      'missing graph fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, secondary);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', secondary.featureBranch);

    const taskDir = path.join(root, worktreePath(runningTask.worktreeBranch));
    await git(
      featureDir,
      'worktree',
      'add',
      taskDir,
      '-b',
      runningTask.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'task change\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'task change');

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    const results = await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(results).toEqual([
      {
        featureId: secondary.id,
        blockedByFeatureId: primary.id,
        kind: 'blocked',
        summary:
          'Cross-feature task rebase conflicted for t-feature-2-running: src/a.ts',
      },
    ]);
    expect(graph.features.get('f-feature-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-feature-1',
    });
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      collabControl: 'suspended',
      status: 'running',
      blockedByFeatureId: 'f-feature-1',
      suspendReason: 'cross_feature_overlap',
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
  }, 20000);

  it('re-blocks feature when suspended task worktree is missing after clean feature rebase', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
      worktreeBranch: 'feat-feature-2-2-task-running',
      reservedWritePaths: ['src/a.ts'],
    });
    const coordinator = new ConflictCoordinator(ports, graph);
    const primary = graph.features.get('f-feature-1');
    const secondary = graph.features.get('f-feature-2');
    const runningTask = graph.tasks.get('t-feature-2-running');

    assert(
      primary !== undefined &&
        secondary !== undefined &&
        runningTask !== undefined,
      'missing graph fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, secondary);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', secondary.featureBranch);

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    const results = await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(results).toEqual([
      {
        featureId: secondary.id,
        blockedByFeatureId: primary.id,
        kind: 'blocked',
        summary: `Task worktree missing for ${runningTask.id}`,
      },
    ]);
    expect(graph.features.get('f-feature-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-feature-1',
    });
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      collabControl: 'suspended',
      status: 'running',
      blockedByFeatureId: 'f-feature-1',
    });
  }, 20000);

  it('ignores cancelled suspended tasks when releasing cross-feature overlap', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'cancelled',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      suspendedAt: 75,
      blockedByFeatureId: 'f-feature-1',
      suspendedFiles: ['src/a.ts'],
    });
    const coordinator = new ConflictCoordinator(ports, graph);

    const results = await coordinator.releaseCrossFeatureOverlap('f-feature-1');

    expect(results).toEqual([]);
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      status: 'cancelled',
      collabControl: 'suspended',
      blockedByFeatureId: 'f-feature-1',
      suspendReason: 'cross_feature_overlap',
    });
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
  });
});
