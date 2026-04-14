import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { Feature, GvcConfig, Task } from '@core/types/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createTaskFixture,
  updateTask,
} from '../../helpers/graph-builders.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createPorts(root: string): OrchestratorPorts {
  void root;
  return {
    store: {} as OrchestratorPorts['store'],
    agents: {} as OrchestratorPorts['agents'],
    verification: {} as OrchestratorPorts['verification'],
    ui: {} as OrchestratorPorts['ui'],
    config: createConfig(),
    runtime: {
      dispatchTask: vi.fn(),
      steerTask: vi.fn(async (taskId: string) => ({
        kind: 'delivered' as const,
        taskId,
        agentRunId: `run-${taskId}`,
      })),
      suspendTask: vi.fn(async (taskId: string) => ({
        kind: 'delivered' as const,
        taskId,
        agentRunId: `run-${taskId}`,
      })),
      resumeTask: vi.fn(async (taskId: string) => ({
        kind: 'delivered' as const,
        taskId,
        agentRunId: `run-${taskId}`,
      })),
      abortTask: vi.fn(),
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

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'base\n');
  const exec = async (command: string) => {
    const { execFile } = await import('node:child_process');
    return new Promise<void>((resolve, reject) => {
      execFile('git', command.split(' '), { cwd: dir }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };
  await exec('init -b main');
  await exec('config user.name Test User');
  await exec('config user.email test@example.com');
  await exec('add README.md .gitignore');
  await exec('commit -m init');
}

async function writeFeatureBranch(
  root: string,
  feature: Feature,
): Promise<string> {
  const branchDir = path.join(root, worktreePath(feature.featureBranch));
  await initRepo(branchDir);
  return branchDir;
}

async function writeTaskBranch(root: string, branch: string): Promise<string> {
  const taskDir = path.join(root, worktreePath(branch));
  await initRepo(taskDir);
  return taskDir;
}

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

  it('suspends lower-priority overlapping tasks', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const coordinator = new ConflictCoordinator(ports);
    const feature = createFeature();
    const dominant = createTask({
      id: 't-dominant',
      worktreeBranch: 'feat-feature-1-1-dominant',
      reservedWritePaths: ['src/a.ts'],
    });
    const secondary = createTask({
      id: 't-secondary',
      worktreeBranch: 'feat-feature-1-1-secondary',
      reservedWritePaths: ['src/a.ts'],
    });

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

  it('resumes suspended task after clean rebase onto feature branch', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const coordinator = new ConflictCoordinator(ports);
    const feature = createFeature();
    await writeFeatureBranch(root, feature);

    const dominant = createTask({
      id: 't-dominant',
      worktreeBranch: 'feat-feature-1-1-dominant',
      reservedWritePaths: ['src/a.ts'],
      result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
    });
    const suspended = createTask({
      id: 't-suspended',
      worktreeBranch: 'feat-feature-1-1-suspended',
      collabControl: 'suspended',
      status: 'running',
      reservedWritePaths: ['src/a.ts'],
    });
    const taskDir = await writeTaskBranch(
      root,
      suspended.worktreeBranch ?? 'feat-feature-1-1-suspended',
    );
    await fs.writeFile(path.join(taskDir, 'src-a.ts'), 'local\n');

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

    expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
      suspended.id,
      'same_feature_rebase',
    );
    expect(ports.runtime.steerTask).not.toHaveBeenCalled();
  });

  it('steers task with conflict context when rebase not clean', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const coordinator = new ConflictCoordinator(ports);
    const feature = createFeature();
    await writeFeatureBranch(root, feature);

    const dominant = createTask({
      id: 't-dominant',
      worktreeBranch: 'feat-feature-1-1-dominant',
      reservedWritePaths: ['src/a.ts'],
      result: { summary: 'dominant landed', filesChanged: ['src/a.ts'] },
    });
    const suspended = createTask({
      id: 't-suspended',
      worktreeBranch: 'feat-feature-1-1-suspended-conflict',
      collabControl: 'suspended',
      status: 'running',
      reservedWritePaths: ['src/a.ts'],
    });
    const taskDir = await writeTaskBranch(
      root,
      suspended.worktreeBranch ?? 'feat-feature-1-1-suspended-conflict',
    );
    await fs.writeFile(path.join(taskDir, 'REBASE_HEAD'), 'blocked\n');

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

    expect(ports.runtime.steerTask).toHaveBeenCalledWith(
      suspended.id,
      expect.objectContaining({
        kind: 'conflict_steer',
        timing: 'immediate',
        gitConflictContext: expect.objectContaining({
          kind: 'same_feature_task_rebase',
          taskId: suspended.id,
          featureId: feature.id,
          files: ['src/a.ts'],
          pauseReason: 'same_feature_overlap',
          dominantTaskId: dominant.id,
          dominantTaskSummary: 'dominant landed',
        }),
      }),
    );
    expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
  });

  it('adds feature dependency and task blocking metadata for cross-feature overlap', async () => {
    const root = getTmpDir();
    const ports = createPorts(root);
    const graph = createGraph();
    updateTask(graph, 't-feature-2-running', {
      status: 'running',
      collabControl: 'branch_open',
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

    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(runningTask).toBeDefined();
    expect(readyTask).toBeDefined();

    if (
      primary === undefined ||
      secondary === undefined ||
      runningTask === undefined ||
      readyTask === undefined
    ) {
      throw new Error('missing graph fixture state');
    }

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
      readyTask,
    ]);

    expect(graph.features.get('f-feature-2')?.dependsOn).toContain(
      'f-feature-1',
    );
    expect(graph.tasks.get('t-feature-2-running')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-feature-1',
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
    );
  });

  it('releases cross-feature dependency and resumes blocked tasks', async () => {
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

    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(runningTask).toBeDefined();

    if (
      primary === undefined ||
      secondary === undefined ||
      runningTask === undefined
    ) {
      throw new Error('missing graph fixture state');
    }

    await coordinator.handleCrossFeatureOverlap(primary, secondary, [
      runningTask,
    ]);
    await coordinator.releaseCrossFeatureOverlap(primary.id);

    expect(graph.features.get('f-feature-2')?.dependsOn).not.toContain(
      'f-feature-1',
    );
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
  });
});
