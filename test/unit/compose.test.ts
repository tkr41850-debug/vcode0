import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  FeaturePhaseAgentRun,
  TaskAgentRun,
} from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import {
  cancelFeatureRunWork,
  composeApplication,
  formatWorkerOutput,
  initializeProjectGraph,
  summarizeApprovalPayload,
} from '@root/compose';
import type { ApprovalPayload, RuntimePort } from '@runtime/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function makeFeaturePhaseRun(
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

describe('compose helpers', () => {
  it('formats wait and terminal worker output for monitor visibility', () => {
    expect(
      formatWorkerOutput({
        type: 'request_help',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        query: 'Need operator guidance',
      }),
    ).toBe('help requested: Need operator guidance');

    expect(
      formatWorkerOutput({
        type: 'request_approval',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        payload: {
          kind: 'custom',
          label: 'Approve destructive step',
          detail: 'Delete generated cache files',
        },
      }),
    ).toBe('approval requested: Approve destructive step');

    expect(
      formatWorkerOutput({
        type: 'error',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        error: 'boom',
      }),
    ).toBe('error: boom');

    expect(
      formatWorkerOutput({
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usd: 0.01,
        },
        result: {
          summary: 'done',
          filesChanged: [],
        },
      }),
    ).toBe('completed: done');
  });

  it('summarizes approval payload labels by kind', () => {
    const payloads: ApprovalPayload[] = [
      {
        kind: 'custom',
        label: 'Approve destructive step',
        detail: 'Delete generated cache files',
      },
      {
        kind: 'destructive_action',
        description: 'Delete generated cache files',
        affectedPaths: ['dist/cache'],
      },
      {
        kind: 'replan_proposal',
        summary: 'Switch to fallback task order',
        proposedMutations: ['move t-2 after t-3'],
      },
    ];

    expect(
      payloads.map((payload) => summarizeApprovalPayload(payload)),
    ).toEqual([
      'Approve destructive step',
      'Delete generated cache files',
      'Switch to fallback task order',
    ]);
  });

  it('cancels feature runs and aborts running tasks while leaving non-running tasks alone', async () => {
    const graph = new InMemoryFeatureGraph();
    graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    const task1 = graph.tasks.get('t-1');
    const task2 = graph.tasks.get('t-2');
    assert(task1 !== undefined, 'missing t-1 fixture');
    assert(task2 !== undefined, 'missing t-2 fixture');
    graph.tasks.set('t-1', {
      ...task1,
      status: 'running',
      collabControl: 'branch_open',
    });
    graph.tasks.set('t-2', {
      ...task2,
      status: 'ready',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-2',
      suspendedAt: 100,
    });

    const runs = new Map<string, AgentRun>([
      ['run-task:t-1', makeTaskRun()],
      [
        'run-task:t-2',
        makeTaskRun({
          id: 'run-task:t-2',
          scopeId: 't-2',
          runStatus: 'ready',
        }),
      ],
      ['run-feature:f-1:plan', makeFeaturePhaseRun()],
    ]);
    const store = {
      listAgentRuns: () => [...runs.values()],
      updateAgentRun: vi.fn((runId: string, patch: Partial<AgentRun>) => {
        const existing = runs.get(runId);
        if (existing !== undefined) {
          runs.set(runId, { ...existing, ...patch } as AgentRun);
        }
      }),
    };
    const runtime = {
      abortTask: vi.fn((taskId: string) =>
        Promise.resolve({
          kind: 'delivered' as const,
          taskId,
          agentRunId: `run-task:${taskId}`,
        }),
      ),
    } as Pick<RuntimePort, 'abortTask'>;

    await cancelFeatureRunWork({ graph, store, runtime }, 'f-1');

    expect(graph.features.get('f-1')).toMatchObject({
      collabControl: 'cancelled',
    });
    expect(graph.tasks.get('t-1')).toMatchObject({ status: 'cancelled' });
    expect(graph.tasks.get('t-2')).toMatchObject({
      status: 'cancelled',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
    });
    expect(runtime.abortTask).toHaveBeenCalledTimes(1);
    expect(runtime.abortTask).toHaveBeenCalledWith('t-1');
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'cancelled',
      owner: 'system',
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-2', {
      runStatus: 'cancelled',
      owner: 'system',
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'cancelled',
      owner: 'system',
    });
  });
});

describe('composeApplication', () => {
  let originalCwd = '';
  let tmpDir = '';

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-app-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('bootstraps app runtime files and lifecycle', async () => {
    const app = await composeApplication();

    await app.stop();

    await expect(fs.stat(path.join(tmpDir, '.gvc0'))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpDir, '.gvc0', 'worktrees')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpDir, '.gvc0', 'config.json')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpDir, '.gvc0', 'state.db')),
    ).resolves.toBeTruthy();

    await expect(
      fs.readFile(path.join(tmpDir, '.gvc0', 'config.json'), 'utf-8'),
    ).resolves.toContain('"tokenProfile": "balanced"');
  });

  it('initializes starter milestone and planning feature through TUI command path', async () => {
    const app = await composeApplication();
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);

    try {
      expect(graph.snapshot().milestones).toEqual([]);
      expect(graph.snapshot().features).toEqual([]);

      const created = initializeProjectGraph(graph, {
        milestoneName: 'Milestone 1',
        milestoneDescription: 'Initial milestone',
        featureName: 'Project startup',
        featureDescription: 'Plan initial project work',
      });

      expect(created.milestoneId).toBeTruthy();
      expect(created.featureId).toBeTruthy();

      const snapshot = graph.snapshot();
      expect(snapshot.milestones).toHaveLength(1);
      const milestone = snapshot.milestones[0];
      expect(milestone).toEqual(
        expect.objectContaining({
          id: created.milestoneId,
          name: 'Milestone 1',
        }),
      );
      expect(milestone?.steeringQueuePosition).toEqual(expect.any(Number));
      expect(snapshot.features).toHaveLength(1);
      expect(snapshot.features[0]).toEqual(
        expect.objectContaining({
          id: created.featureId,
          milestoneId: created.milestoneId,
          workControl: 'planning',
          status: 'pending',
          collabControl: 'none',
        }),
      );
    } finally {
      db.close();
      await app.stop();
    }
  });

  it('rejects repeated project initialization', async () => {
    const app = await composeApplication();
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);

    try {
      initializeProjectGraph(graph, {
        milestoneName: 'Milestone 1',
        milestoneDescription: 'Initial milestone',
        featureName: 'Project startup',
        featureDescription: 'Plan initial project work',
      });

      expect(() =>
        initializeProjectGraph(graph, {
          milestoneName: 'Milestone 2',
          milestoneDescription: 'Another milestone',
          featureName: 'Another feature',
          featureDescription: 'Should not be created',
        }),
      ).toThrow('project already initialized');
    } finally {
      db.close();
      await app.stop();
    }
  });
});
