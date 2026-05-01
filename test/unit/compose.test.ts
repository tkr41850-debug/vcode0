import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { JsonConfigLoader } from '@config';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  FeaturePhaseAgentRun,
  GvcConfig,
  TaskAgentRun,
} from '@core/types/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { RecoveryService } from '@orchestrator/services/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import {
  abandonFeatureBranch,
  applyConfigUpdate,
  cancelFeatureRunWork,
  cancelTaskCleanWorktree,
  cancelTaskPreserveWorktree,
  cleanOrphanWorktree,
  composeApplication,
  decideInboxApproval,
  formatWorkerOutput,
  initializeProjectGraph,
  inspectOrphanWorktree,
  keepOrphanWorktree,
  respondToInboxHelp,
  summarizeApprovalPayload,
} from '@root/compose';
import { SqliteStore } from '@persistence/sqlite-store';
import type { ApprovalPayload, RuntimePort } from '@runtime/contracts';
import { TuiApp } from '@tui/app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import { InMemoryStore } from '../integration/harness/store-memory.js';

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

function makeConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function appendOrphanInboxItem(
  store: InMemoryStore,
  projectRoot: string,
  overrides: Partial<{
    id: string;
    taskId: string;
    featureId: string;
    branch: string;
    ownerState: 'dead' | 'absent';
    registered: boolean;
    hasMetadataIndexLock: boolean;
    path: string;
    kind: string;
    payload: unknown;
  }> = {},
): string {
  const branch = overrides.branch ?? 'feat-f-1-task-t-1';
  const payload =
    overrides.payload ?? {
      taskId: overrides.taskId ?? 't-1',
      featureId: overrides.featureId ?? 'f-1',
      branch,
      path:
        overrides.path ??
        path.join(projectRoot, '.gvc0', 'worktrees', branch),
      ownerState: overrides.ownerState ?? 'dead',
      registered: overrides.registered ?? true,
      hasMetadataIndexLock: overrides.hasMetadataIndexLock ?? false,
      equivalenceKey: `orphan_worktree:${branch}:${overrides.path ?? path.join(projectRoot, '.gvc0', 'worktrees', branch)}`,
    };
  const id = overrides.id ?? 'inbox-orphan-1';
  store.appendInboxItem({
    id,
    ts: 1,
    taskId: overrides.taskId ?? 't-1',
    featureId: overrides.featureId ?? 'f-1',
    kind: overrides.kind ?? 'orphan_worktree',
    payload,
  });
  return id;
}

describe('compose helpers', () => {
  it('formats wait and terminal worker output for monitor visibility', () => {
    expect(
      formatWorkerOutput({
        type: 'request_help',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        query: 'Need operator guidance',
        toolCallId: 'call-help-1',
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
        toolCallId: 'call-approval-1',
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

  it('cancels a task while preserving its worktree and aborts at most one live run', async () => {
    const graph = new InMemoryFeatureGraph();
    graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    const task = graph.tasks.get('t-1');
    assert(task !== undefined, 'missing t-1 fixture');
    graph.tasks.set('t-1', {
      ...task,
      status: 'running',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-2',
      suspendedAt: 100,
    });

    const runs = new Map<string, AgentRun>([
      ['run-task:t-1', makeTaskRun()],
      [
        'run-task:t-1:wait',
        makeTaskRun({
          id: 'run-task:t-1:wait',
          runStatus: 'await_response',
        }),
      ],
      [
        'run-task:t-1:ready',
        makeTaskRun({
          id: 'run-task:t-1:ready',
          runStatus: 'ready',
        }),
      ],
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

    await cancelTaskPreserveWorktree({ graph, store, runtime }, 't-1');

    expect(graph.tasks.get('t-1')).toMatchObject({
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
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-1:wait', {
      runStatus: 'cancelled',
      owner: 'system',
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-1:ready', {
      runStatus: 'cancelled',
      owner: 'system',
    });
  });

  it('cancels a task and removes its worktree when clean cancel is requested', async () => {
    const graph = new InMemoryFeatureGraph();
    graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    const task = graph.tasks.get('t-1');
    assert(task !== undefined, 'missing t-1 fixture');
    graph.tasks.set('t-1', {
      ...task,
      status: 'ready',
      worktreeBranch: 'feat-task-clean',
    });

    const store = {
      listAgentRuns: () =>
        [makeTaskRun({ scopeId: 't-1', runStatus: 'ready' })] as AgentRun[],
      updateAgentRun: vi.fn(),
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
    const worktree = {
      removeWorktree: vi.fn(() => Promise.resolve()),
    };

    await cancelTaskCleanWorktree({ graph, store, runtime, worktree }, 't-1');

    expect(graph.tasks.get('t-1')).toMatchObject({ status: 'cancelled' });
    expect(worktree.removeWorktree).toHaveBeenCalledWith('feat-task-clean');
  });

  it('abandons a feature by cancelling runs, removing worktrees, and deleting branches', async () => {
    const graph = new InMemoryFeatureGraph();
    graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
    graph.createFeature({
      id: 'f-1',
      milestoneId: 'm-1',
      name: 'Feature 1',
      description: 'desc',
    });
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing f-1 fixture');
    graph.features.set('f-1', {
      ...feature,
      featureBranch: 'feat-feature-1',
    });
    graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });
    graph.createTask({ id: 't-2', featureId: 'f-1', description: 'Task 2' });
    const t1 = graph.tasks.get('t-1');
    const t2 = graph.tasks.get('t-2');
    assert(t1 !== undefined, 'missing t-1 fixture');
    assert(t2 !== undefined, 'missing t-2 fixture');
    graph.tasks.set('t-1', {
      ...t1,
      status: 'running',
      worktreeBranch: 'feat-feature-1-task-1',
    });
    graph.tasks.set('t-2', {
      ...t2,
      status: 'ready',
      worktreeBranch: 'feat-feature-1-task-2',
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
    const worktree = {
      removeWorktree: vi.fn(() => Promise.resolve()),
      deleteBranch: vi.fn(() => Promise.resolve()),
    };

    await abandonFeatureBranch({ graph, store, runtime, worktree }, 'f-1');

    expect(graph.features.get('f-1')).toMatchObject({
      collabControl: 'cancelled',
    });
    expect(graph.tasks.get('t-1')).toMatchObject({ status: 'cancelled' });
    expect(graph.tasks.get('t-2')).toMatchObject({ status: 'cancelled' });
    expect(runtime.abortTask).toHaveBeenCalledTimes(1);
    expect(runtime.abortTask).toHaveBeenCalledWith('t-1');
    expect(worktree.removeWorktree.mock.calls).toEqual([
      ['feat-feature-1-task-1'],
      ['feat-feature-1-task-2'],
      ['feat-feature-1'],
    ]);
    expect(worktree.deleteBranch.mock.calls).toEqual([
      ['feat-feature-1-task-1'],
      ['feat-feature-1-task-2'],
      ['feat-feature-1'],
    ]);
  });

  it('applies live config updates across runtime, scheduler, and harness while persisting validated config', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join('/tmp', 'compose-config-update-'),
    );
    try {
      const configPath = path.join(tmpDir, 'gvc0.config.json');
      const sourceConfig = makeConfig();
      await fs.writeFile(configPath, JSON.stringify(sourceConfig), 'utf-8');
      const configSource = new JsonConfigLoader(configPath);
      const currentConfig = makeConfig();
      const nextConfig = makeConfig({
        workerCap: 7,
        retryCap: 9,
        reentryCap: 4,
        pauseTimeouts: { hotWindowMs: 1234 },
        models: {
          ...sourceConfig.models,
          taskWorker: { provider: 'anthropic', model: 'claude-opus-4-7' },
        },
      });
      const runtime = {
        setMaxConcurrency: vi.fn(),
        setRetryPolicyConfig: vi.fn(),
        setHotWindowMs: vi.fn(),
      };
      const scheduler = { setReentryCap: vi.fn() };
      const harness = { setTaskWorkerModel: vi.fn() };

      const updated = await applyConfigUpdate(
        configSource,
        currentConfig,
        nextConfig,
        {
          runtime,
          scheduler,
          harness,
        },
      );

      expect(updated).toBe(currentConfig);
      expect(currentConfig.workerCap).toBe(7);
      expect(currentConfig.retryCap).toBe(9);
      expect(currentConfig.reentryCap).toBe(4);
      expect(currentConfig.pauseTimeouts.hotWindowMs).toBe(1234);
      expect(currentConfig.models.taskWorker.model).toBe('claude-opus-4-7');
      expect(runtime.setMaxConcurrency).toHaveBeenCalledWith(7);
      expect(runtime.setHotWindowMs).toHaveBeenCalledWith(1234);
      expect(runtime.setRetryPolicyConfig).toHaveBeenCalledWith(
        expect.objectContaining({ maxAttempts: 9 }),
      );
      expect(scheduler.setReentryCap).toHaveBeenCalledWith(4);
      expect(harness.setTaskWorkerModel).toHaveBeenCalledWith({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      });
      const persisted = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(persisted.workerCap).toBe(7);
      expect(persisted.retryCap).toBe(9);
      expect(persisted.reentryCap).toBe(4);
      expect(persisted.pauseTimeouts.hotWindowMs).toBe(1234);
      expect(persisted.models.taskWorker.model).toBe('claude-opus-4-7');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replays checkpointed help waits by persisting tool output and resuming the task', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-replay-help-'));
    try {
      const graph = new InMemoryFeatureGraph();
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Feature 1',
        description: 'desc',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });

      const store = new InMemoryStore();
      store.createAgentRun(
        makeTaskRun({
          runStatus: 'checkpointed_await_response',
          owner: 'manual',
          sessionId: 'sess-1',
          payloadJson: JSON.stringify({
            query: 'Need operator guidance',
            toolCallId: 'call-help-1',
          }),
        }),
      );
      store.appendInboxItem({
        id: 'inbox-1',
        ts: 1,
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        featureId: 'f-1',
        kind: 'agent_help',
        payload: { query: 'Need operator guidance' },
      });

      const runtime = {
        dispatchTask: vi.fn(() =>
          Promise.resolve({
            kind: 'resumed' as const,
            taskId: 't-1',
            agentRunId: 'run-task:t-1',
            sessionId: 'sess-1',
          }),
        ),
        respondToHelp: vi.fn(),
        decideApproval: vi.fn(),
      } as Pick<
        RuntimePort,
        'dispatchTask' | 'respondToHelp' | 'decideApproval'
      >;

      await expect(
        respondToInboxHelp(
          { store, runtime, graph, projectRoot: tmpDir },
          'inbox-1',
          {
            kind: 'answer',
            text: 'Use option B',
          },
        ),
      ).resolves.toBe('Sent help response to t-1.');

      expect(runtime.dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't-1' }),
        {
          mode: 'resume',
          agentRunId: 'run-task:t-1',
          sessionId: 'sess-1',
        },
        expect.any(Object),
      );
      const persisted = JSON.parse(
        await fs.readFile(
          path.join(
            tmpDir,
            '.gvc0',
            'tool-outputs',
            'sess-1',
            'call-help-1.json',
          ),
          'utf-8',
        ),
      );
      expect(persisted).toMatchObject({
        toolCallId: 'call-help-1',
        toolName: 'request_help',
        content: [{ type: 'text', text: 'Use option B' }],
        details: {
          query: 'Need operator guidance',
          responseKind: 'answer',
        },
        isError: false,
      });
      expect(store.getAgentRun('run-task:t-1')).toMatchObject({
        runStatus: 'running',
        owner: 'manual',
        restartCount: 1,
        sessionId: 'sess-1',
      });
      expect(
        store.listInboxItems({ kind: 'agent_help' })[0]?.resolution,
      ).toEqual({
        kind: 'answered',
        resolvedAt: expect.any(Number),
        note: 'Use option B',
        fanoutTaskIds: ['t-1'],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replays checkpointed approval waits by persisting tool output and resuming the task', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join('/tmp', 'compose-replay-approval-'),
    );
    try {
      const graph = new InMemoryFeatureGraph();
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Feature 1',
        description: 'desc',
      });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'Task 1' });

      const store = new InMemoryStore();
      store.createAgentRun(
        makeTaskRun({
          runStatus: 'checkpointed_await_approval',
          owner: 'manual',
          sessionId: 'sess-1',
          payloadJson: JSON.stringify({
            kind: 'custom',
            label: 'Need approval',
            detail: 'Proceed with guarded change',
            toolCallId: 'call-approval-1',
          }),
        }),
      );
      store.appendInboxItem({
        id: 'inbox-1',
        ts: 1,
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        featureId: 'f-1',
        kind: 'agent_approval',
        payload: {
          kind: 'custom',
          label: 'Need approval',
          detail: 'Proceed with guarded change',
        },
      });

      const runtime = {
        dispatchTask: vi.fn(() =>
          Promise.resolve({
            kind: 'resumed' as const,
            taskId: 't-1',
            agentRunId: 'run-task:t-1',
            sessionId: 'sess-1',
          }),
        ),
        respondToHelp: vi.fn(),
        decideApproval: vi.fn(),
      } as Pick<
        RuntimePort,
        'dispatchTask' | 'respondToHelp' | 'decideApproval'
      >;

      await expect(
        decideInboxApproval(
          { store, runtime, graph, projectRoot: tmpDir },
          'inbox-1',
          { kind: 'approved' },
        ),
      ).resolves.toBe('Approved t-1.');

      expect(runtime.dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't-1' }),
        {
          mode: 'resume',
          agentRunId: 'run-task:t-1',
          sessionId: 'sess-1',
        },
        expect.any(Object),
      );
      const persisted = JSON.parse(
        await fs.readFile(
          path.join(
            tmpDir,
            '.gvc0',
            'tool-outputs',
            'sess-1',
            'call-approval-1.json',
          ),
          'utf-8',
        ),
      );
      expect(persisted).toMatchObject({
        toolCallId: 'call-approval-1',
        toolName: 'request_approval',
        content: [{ type: 'text', text: 'approved' }],
        details: {
          kind: 'custom',
          decision: 'approved',
        },
        isError: false,
      });
      expect(store.getAgentRun('run-task:t-1')).toMatchObject({
        runStatus: 'running',
        owner: 'manual',
        restartCount: 1,
        sessionId: 'sess-1',
      });
      expect(
        store.listInboxItems({ kind: 'agent_approval' })[0]?.resolution,
      ).toEqual({
        kind: 'approved',
        resolvedAt: expect.any(Number),
        fanoutTaskIds: ['t-1'],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cleans orphan worktrees and resolves their inbox items', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-orphan-clean-'));
    try {
      const store = new InMemoryStore();
      const inboxItemId = appendOrphanInboxItem(store, tmpDir);
      const worktree = { removeWorktree: vi.fn(async () => {}) };

      await expect(
        cleanOrphanWorktree({ store, worktree, projectRoot: tmpDir }, inboxItemId),
      ).resolves.toBe('Removed orphan worktree feat-f-1-task-t-1.');

      expect(worktree.removeWorktree).toHaveBeenCalledWith('feat-f-1-task-t-1');
      expect(store.listInboxItems({ kind: 'orphan_worktree' })[0]?.resolution).toEqual({
        kind: 'dismissed',
        resolvedAt: expect.any(Number),
        note: 'cleaned feat-f-1-task-t-1',
        fanoutTaskIds: ['t-1'],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('inspects orphan worktrees without resolving their inbox items', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-orphan-inspect-'));
    try {
      const store = new InMemoryStore();
      const inboxItemId = appendOrphanInboxItem(store, tmpDir, {
        ownerState: 'absent',
        registered: false,
        hasMetadataIndexLock: true,
      });

      await expect(
        inspectOrphanWorktree({ store, projectRoot: tmpDir }, inboxItemId),
      ).resolves.toBe(
        'Orphan feat-f-1-task-t-1 owner=absent registered=no lock=yes path=.gvc0/worktrees/feat-f-1-task-t-1',
      );
      expect(
        store.listInboxItems({ kind: 'orphan_worktree' })[0]?.resolution,
      ).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps orphan worktrees by resolving their inbox items without cleanup', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-orphan-keep-'));
    try {
      const store = new InMemoryStore();
      const inboxItemId = appendOrphanInboxItem(store, tmpDir);

      await expect(
        keepOrphanWorktree({ store, projectRoot: tmpDir }, inboxItemId),
      ).resolves.toBe('Kept orphan worktree feat-f-1-task-t-1.');
      expect(store.listInboxItems({ kind: 'orphan_worktree' })[0]?.resolution).toEqual({
        kind: 'dismissed',
        resolvedAt: expect.any(Number),
        note: 'kept feat-f-1-task-t-1',
        fanoutTaskIds: ['t-1'],
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid orphan inbox payloads and mismatched kinds', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-orphan-guards-'));
    try {
      const store = new InMemoryStore();
      const wrongKindId = appendOrphanInboxItem(store, tmpDir, {
        id: 'inbox-wrong-kind',
        kind: 'agent_help',
      });
      const invalidPayloadId = appendOrphanInboxItem(store, tmpDir, {
        id: 'inbox-invalid-payload',
        payload: { branch: 'feat-f-1-task-t-1' },
      });
      const invalidPathId = appendOrphanInboxItem(store, tmpDir, {
        id: 'inbox-invalid-path',
        path: path.join(tmpDir, 'outside', 'feat-f-1-task-t-1'),
      });
      const worktree = { removeWorktree: vi.fn(async () => {}) };

      await expect(
        cleanOrphanWorktree({ store, worktree, projectRoot: tmpDir }, wrongKindId),
      ).rejects.toThrow(
        'inbox item "inbox-wrong-kind" is not an orphan worktree item',
      );
      await expect(
        keepOrphanWorktree({ store, projectRoot: tmpDir }, invalidPayloadId),
      ).rejects.toThrow(
        'inbox item "inbox-invalid-payload" has invalid orphan payload',
      );
      await expect(
        inspectOrphanWorktree({ store, projectRoot: tmpDir }, invalidPathId),
      ).rejects.toThrow(
        'inbox item for feat-f-1-task-t-1 does not point to a managed task worktree',
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('composeApplication', () => {
  let originalCwd = '';
  let tmpDir = '';

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'compose-app-'));
    process.chdir(tmpDir);

    // The loader no longer auto-creates gvc0.config.json — boot-time
    // validation is strict (REQ-CONFIG-01). Seed a minimal valid config so
    // compose() can proceed.
    await fs.writeFile(
      path.join(tmpDir, 'gvc0.config.json'),
      JSON.stringify({
        models: {
          topPlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          featurePlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          taskWorker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
          verifier: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        },
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
      fs.stat(path.join(tmpDir, '.gvc0', 'state.db')),
    ).resolves.toBeTruthy();
  });

  it('runs startup recovery before scheduler start', async () => {
    const order: string[] = [];
    vi.spyOn(TuiApp.prototype, 'show').mockImplementation(async () => {
      order.push('show');
    });
    vi.spyOn(TuiApp.prototype, 'refresh').mockImplementation(() => {
      order.push('refresh');
    });
    vi.spyOn(
      RecoveryService.prototype,
      'recoverStartupState',
    ).mockImplementation(async () => {
      order.push('recover');
      return {
        liveWorkerPids: [],
        clearedDeadWorkerPids: [],
        clearedLocks: [],
        preservedLocks: [],
        orphanTaskWorktrees: [],
        resumedRuns: [],
        restartedRuns: [],
        attentionRuns: [],
        requiresAttention: false,
      };
    });
    vi.spyOn(SchedulerLoop.prototype, 'run').mockImplementation(() => {
      order.push('run');
      return Promise.resolve();
    });
    vi.spyOn(SchedulerLoop.prototype, 'stop').mockImplementation(() => {
      return Promise.resolve();
    });

    const app = await composeApplication();

    try {
      await app.start('auto');
      expect(order).toEqual(['show', 'recover', 'run', 'refresh']);
      const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
      const store = new SqliteStore(db);
      try {
        expect(store.listInboxItems({ kind: 'recovery_summary' })).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await app.stop();
    }
  });

  it('appends a recovery summary inbox item when startup recovery finds notable facts', async () => {
    vi.spyOn(TuiApp.prototype, 'show').mockImplementation(async () => {});
    vi.spyOn(TuiApp.prototype, 'refresh').mockImplementation(() => {});
    vi.spyOn(
      RecoveryService.prototype,
      'recoverStartupState',
    ).mockResolvedValue({
      liveWorkerPids: [],
      clearedDeadWorkerPids: [
        {
          agentRunId: 'run-task:t-1',
          pid: 123,
          taskId: 't-1',
        },
      ],
      clearedLocks: [
        {
          kind: 'root_index_lock',
          path: '/tmp/repo/.git/index.lock',
        },
      ],
      preservedLocks: [],
      orphanTaskWorktrees: [
        {
          taskId: 't-1',
          featureId: 'f-1',
          branch: 'feat-task-t-1',
          path: '/tmp/repo/.gvc0/worktrees/feat-task-t-1',
          ownerState: 'dead',
          registered: true,
          hasMetadataIndexLock: false,
        },
      ],
      resumedRuns: [
        {
          taskId: 't-1',
          agentRunId: 'run-task:t-1',
          sessionId: 'sess-1',
        },
      ],
      restartedRuns: [
        {
          taskId: 't-2',
          agentRunId: 'run-task:t-2',
          sessionId: 'sess-2',
          reason: 'session_not_found',
        },
      ],
      attentionRuns: [],
      requiresAttention: true,
    });
    vi.spyOn(SchedulerLoop.prototype, 'run').mockResolvedValue();
    vi.spyOn(SchedulerLoop.prototype, 'stop').mockResolvedValue();

    const app = await composeApplication();

    try {
      await app.start('auto');
      const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
      const store = new SqliteStore(db);
      try {
        expect(store.listInboxItems({ kind: 'recovery_summary' })).toEqual([
          expect.objectContaining({
            kind: 'recovery_summary',
            payload: {
              clearedLocks: 1,
              preservedLocks: 0,
              clearedDeadWorkerPids: 1,
              resumedRuns: 1,
              restartedRuns: 1,
              attentionRuns: 0,
              orphanTaskWorktrees: 1,
            },
          }),
        ]);
        expect(store.listInboxItems({ kind: 'orphan_worktree' })).toEqual([
          expect.objectContaining({
            taskId: 't-1',
            featureId: 'f-1',
            kind: 'orphan_worktree',
            payload: {
              taskId: 't-1',
              featureId: 'f-1',
              branch: 'feat-task-t-1',
              path: '/tmp/repo/.gvc0/worktrees/feat-task-t-1',
              ownerState: 'dead',
              registered: true,
              hasMetadataIndexLock: false,
              equivalenceKey:
                'orphan_worktree:feat-task-t-1:/tmp/repo/.gvc0/worktrees/feat-task-t-1',
            },
          }),
        ]);
      } finally {
        store.close();
      }
    } finally {
      await app.stop();
    }
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
