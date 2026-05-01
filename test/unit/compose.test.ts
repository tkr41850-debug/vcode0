import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  FeaturePhaseAgentRun,
  TaskAgentRun,
} from '@core/types/index';
import { ProjectPlannerCoordinator } from '@orchestrator/services/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { SqliteStore } from '@persistence/sqlite-store';
import {
  attachFeaturePhaseRunImpl,
  cancelFeatureRunWork,
  composeApplication,
  decidePendingTaskApproval,
  formatWorkerOutput,
  initializeProjectGraph,
  releaseFeaturePhaseToSchedulerImpl,
  respondToPendingTaskHelp,
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
        toolCallId: 'tool-help-1',
        query: 'Need operator guidance',
      }),
    ).toBe('help requested: Need operator guidance');

    expect(
      formatWorkerOutput({
        type: 'request_approval',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        toolCallId: 'tool-approval-1',
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
    graph.__enterTick();
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
      abortRun: vi.fn((agentRunId: string) =>
        Promise.resolve({
          kind: 'delivered' as const,
          taskId: agentRunId,
          agentRunId,
        }),
      ),
    } as Pick<RuntimePort, 'abortRun'>;

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
    expect(runtime.abortRun).toHaveBeenCalledTimes(2);
    expect(runtime.abortRun).toHaveBeenCalledWith('run-task:t-1');
    expect(runtime.abortRun).toHaveBeenCalledWith('run-feature:f-1:plan');
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'cancelled',
      owner: 'system',
      attention: 'none',
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-2', {
      runStatus: 'cancelled',
      owner: 'system',
      attention: 'none',
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'cancelled',
      owner: 'system',
      attention: 'none',
    });
  });
});

describe('compose task-reply helpers', () => {
  it('forwards help replies with pending wait toolCallId from stored payload', async () => {
    const run = makeTaskRun({
      runStatus: 'await_response',
      payloadJson: JSON.stringify({
        toolCallId: 'tool-help-1',
        query: 'Need operator guidance',
      }),
    });
    const store = {
      getAgentRun: vi.fn(() => run),
      updateAgentRun: vi.fn(),
    };
    const runtime = {
      respondToRunHelp: vi.fn().mockResolvedValue({
        kind: 'delivered',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
      }),
    };

    await expect(
      respondToPendingTaskHelp(store, runtime, 't-1', {
        kind: 'answer',
        text: 'Use option B',
      }),
    ).resolves.toBe('Sent help response to t-1.');
    expect(runtime.respondToRunHelp).toHaveBeenCalledWith(
      'run-task:t-1',
      'tool-help-1',
      { kind: 'answer', text: 'Use option B' },
    );
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'manual',
      payloadJson: undefined,
    });
  });

  it('forwards approval decisions with pending wait toolCallId from stored payload', async () => {
    const run = makeTaskRun({
      runStatus: 'await_approval',
      payloadJson: JSON.stringify({
        toolCallId: 'tool-approval-1',
        kind: 'custom',
        label: 'Need approval',
        detail: 'delete file',
      }),
    });
    const store = {
      getAgentRun: vi.fn(() => run),
      updateAgentRun: vi.fn(),
    };
    const runtime = {
      decideRunApproval: vi.fn().mockResolvedValue({
        kind: 'delivered',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
      }),
    };

    await expect(
      decidePendingTaskApproval(store, runtime, 't-1', { kind: 'approved' }),
    ).resolves.toBe('Approved t-1.');
    expect(runtime.decideRunApproval).toHaveBeenCalledWith(
      'run-task:t-1',
      'tool-approval-1',
      { kind: 'approved' },
    );
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'manual',
      payloadJson: undefined,
    });
  });

  it('rejects missing pending wait toolCallId when replying', async () => {
    const run = makeTaskRun({
      runStatus: 'await_response',
      payloadJson: JSON.stringify({ query: 'Need operator guidance' }),
    });
    const store = {
      getAgentRun: vi.fn(() => run),
      updateAgentRun: vi.fn(),
    };
    const runtime = {
      respondToRunHelp: vi.fn(),
    };

    await expect(
      respondToPendingTaskHelp(store, runtime, 't-1', {
        kind: 'answer',
        text: 'Use option B',
      }),
    ).rejects.toThrow('missing pending wait toolCallId');
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

  it('greenfield bootstrap: returns greenfield-bootstrap with sessionId, no synthetic milestones/features', async () => {
    const app = await composeApplication();
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);
    const store = new SqliteStore(db);

    try {
      expect(graph.snapshot().milestones).toEqual([]);
      expect(graph.snapshot().features).toEqual([]);

      const projectPlanner = new ProjectPlannerCoordinator(
        {
          store,
          runtime: { idleWorkerCount: () => 1 },
          config: { tokenProfile: 'balanced' as const },
        } as never,
        graph as never,
        () => Promise.resolve(),
        { dispatchFn: () => Promise.resolve(), idGen: () => 'sess-bootstrap' },
      );

      const result = await initializeProjectGraph(graph, projectPlanner);

      expect(result).toEqual({
        kind: 'greenfield-bootstrap',
        sessionId: 'run-project:sess-bootstrap',
      });
      expect(graph.snapshot().milestones).toEqual([]);
      expect(graph.snapshot().features).toEqual([]);
      expect(
        store.listProjectSessions({ runStatuses: ['running'] }),
      ).toHaveLength(1);
    } finally {
      db.close();
      await app.stop();
    }
  });

  it('greenfield bootstrap (persisted-but-empty .gvc0/state.db): same outcome as fresh', async () => {
    const app = await composeApplication();
    // composeApplication already created .gvc0/state.db; treat that as the
    // persisted-but-empty case (no milestone or feature rows written yet).
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);
    const store = new SqliteStore(db);

    try {
      const projectPlanner = new ProjectPlannerCoordinator(
        {
          store,
          runtime: { idleWorkerCount: () => 1 },
          config: { tokenProfile: 'balanced' as const },
        } as never,
        graph as never,
        () => Promise.resolve(),
        { dispatchFn: () => Promise.resolve(), idGen: () => 'sess-empty' },
      );

      const result = await initializeProjectGraph(graph, projectPlanner);

      expect(result).toEqual({
        kind: 'greenfield-bootstrap',
        sessionId: 'run-project:sess-empty',
      });
      expect(
        store.listProjectSessions({ runStatuses: ['running'] }),
      ).toHaveLength(1);
    } finally {
      db.close();
      await app.stop();
    }
  });

  it('existing-project: pre-seeded graph returns existing kind and does not auto-spawn', async () => {
    const app = await composeApplication();
    const db = openDatabase(path.join(tmpDir, '.gvc0', 'state.db'));
    const graph = new PersistentFeatureGraph(db);
    const store = new SqliteStore(db);

    try {
      graph.__enterTick();
      try {
        graph.createMilestone({
          id: 'm-existing',
          name: 'Existing milestone',
          description: 'pre-seeded',
        });
        graph.createFeature({
          id: 'f-existing',
          milestoneId: 'm-existing',
          name: 'Existing feature',
          description: 'pre-seeded',
        });
      } finally {
        graph.__leaveTick();
      }

      const projectPlanner = new ProjectPlannerCoordinator(
        {
          store,
          runtime: { idleWorkerCount: () => 1 },
          config: { tokenProfile: 'balanced' as const },
        } as never,
        graph as never,
        () => Promise.resolve(),
        { dispatchFn: () => Promise.resolve(), idGen: () => 'sess-x' },
      );

      const before = store.listProjectSessions({
        runStatuses: ['running'],
      }).length;
      const result = await initializeProjectGraph(graph, projectPlanner);

      expect(result).toEqual({ kind: 'existing' });
      expect(
        store.listProjectSessions({ runStatuses: ['running'] }).length,
      ).toBe(before);
    } finally {
      db.close();
      await app.stop();
    }
  });
});

describe('compose feature-phase attach/release helpers', () => {
  function makeStore(initial: AgentRun[]) {
    const runs = new Map(initial.map((run) => [run.id, run]));
    const events: Array<{
      eventType: string;
      entityId: string;
      payload: unknown;
    }> = [];
    return {
      getAgentRun: (runId: string) => runs.get(runId),
      updateAgentRun: vi.fn((runId: string, patch: Partial<AgentRun>) => {
        const existing = runs.get(runId);
        if (existing !== undefined) {
          runs.set(runId, { ...existing, ...patch } as AgentRun);
        }
      }),
      appendEvent: vi.fn(
        (event: {
          eventType: string;
          entityId: string;
          timestamp: number;
          payload?: unknown;
        }) => {
          events.push({
            eventType: event.eventType,
            entityId: event.entityId,
            payload: event.payload,
          });
        },
      ),
      runs,
      events,
    };
  }

  it('attachFeaturePhaseRunImpl flips running run to manual/operator + appends audit event + refreshes UI', async () => {
    const store = makeStore([
      makeFeaturePhaseRun({
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
      }),
    ]);
    const ui = { refresh: vi.fn() };

    const message = await attachFeaturePhaseRunImpl(
      { store, ui },
      'f-1',
      'plan',
    );

    expect(message).toBe('Attached to f-1 planner.');
    expect(store.runs.get('run-feature:f-1:plan')).toMatchObject({
      owner: 'manual',
      attention: 'operator',
    });
    expect(store.events).toEqual([
      {
        eventType: 'feature_phase_attached',
        entityId: 'f-1',
        payload: { phase: 'plan' },
      },
    ]);
    expect(ui.refresh).toHaveBeenCalledTimes(1);
  });

  it('attachFeaturePhaseRunImpl rejects when run is in await_approval (not_running)', async () => {
    const store = makeStore([
      makeFeaturePhaseRun({
        runStatus: 'await_approval',
        owner: 'manual',
        attention: 'none',
      }),
    ]);
    const ui = { refresh: vi.fn() };

    await expect(
      attachFeaturePhaseRunImpl({ store, ui }, 'f-1', 'plan'),
    ).rejects.toThrow(/not live/i);

    expect(store.events[0]).toMatchObject({
      eventType: 'feature_phase_attach_rejected',
      payload: { phase: 'plan', reason: 'not_running' },
    });
    expect(ui.refresh).not.toHaveBeenCalled();
  });

  it('attachFeaturePhaseRunImpl rejects when already manual', async () => {
    const store = makeStore([
      makeFeaturePhaseRun({
        runStatus: 'running',
        owner: 'manual',
        attention: 'operator',
      }),
    ]);
    const ui = { refresh: vi.fn() };

    await expect(
      attachFeaturePhaseRunImpl({ store, ui }, 'f-1', 'plan'),
    ).rejects.toThrow(/already attached/i);

    expect(store.events[0]).toMatchObject({
      eventType: 'feature_phase_attach_rejected',
      payload: { phase: 'plan', reason: 'already_manual' },
    });
  });

  it('releaseFeaturePhaseToSchedulerImpl flips attached run back to system/none + appends audit event', async () => {
    const store = makeStore([
      makeFeaturePhaseRun({
        runStatus: 'running',
        owner: 'manual',
        attention: 'operator',
      }),
    ]);
    const runtime = {
      listPendingFeaturePhaseHelp: vi.fn(() => []),
    };
    const ui = { refresh: vi.fn() };

    const message = await releaseFeaturePhaseToSchedulerImpl(
      { store, runtime, ui },
      'f-1',
      'plan',
    );

    expect(message).toBe('Released f-1 back to scheduler.');
    expect(store.runs.get('run-feature:f-1:plan')).toMatchObject({
      owner: 'system',
      attention: 'none',
    });
    expect(store.events).toEqual([
      {
        eventType: 'feature_phase_released',
        entityId: 'f-1',
        payload: { phase: 'plan' },
      },
    ]);
    expect(ui.refresh).toHaveBeenCalledTimes(1);
  });

  it('releaseFeaturePhaseToSchedulerImpl rejects with pending_help while await_response', async () => {
    const store = makeStore([
      makeFeaturePhaseRun({
        runStatus: 'await_response',
        owner: 'manual',
        attention: 'operator',
        payloadJson: JSON.stringify({
          toolCallId: 'tool-help-1',
          query: 'q',
        }),
      }),
    ]);
    const runtime = {
      listPendingFeaturePhaseHelp: vi.fn(() => [
        { toolCallId: 'tool-help-1', query: 'q' },
      ]),
    };
    const ui = { refresh: vi.fn() };

    await expect(
      releaseFeaturePhaseToSchedulerImpl({ store, runtime, ui }, 'f-1', 'plan'),
    ).rejects.toThrow(/pending help/i);

    expect(store.events[0]).toMatchObject({
      eventType: 'feature_phase_release_rejected',
      payload: {
        phase: 'plan',
        reason: 'pending_help',
        pendingToolCallIds: ['tool-help-1'],
      },
    });
    expect(ui.refresh).not.toHaveBeenCalled();
  });

  it('releaseFeaturePhaseToSchedulerImpl rejects when not attached', async () => {
    const store = makeStore([
      makeFeaturePhaseRun({
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
      }),
    ]);
    const runtime = {
      listPendingFeaturePhaseHelp: vi.fn(() => []),
    };
    const ui = { refresh: vi.fn() };

    await expect(
      releaseFeaturePhaseToSchedulerImpl({ store, runtime, ui }, 'f-1', 'plan'),
    ).rejects.toThrow(/not attached/i);

    expect(store.events[0]).toMatchObject({
      eventType: 'feature_phase_release_rejected',
      payload: { phase: 'plan', reason: 'not_attached' },
    });
  });
});
