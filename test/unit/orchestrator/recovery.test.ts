import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { TaskAgentRun } from '@core/types/index';
import type {
  OrchestratorPorts,
  Store,
  UiPort,
} from '@orchestrator/ports/index';
import { RecoveryService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import type { WorkerPidRegistry } from '@runtime/worktree/index';
import { describe, expect, it, vi } from 'vitest';

import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-task-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function createStoreMock(runs: TaskAgentRun[]): Store {
  const byId = new Map<string, TaskAgentRun>(runs.map((run) => [run.id, run]));
  return {
    getAgentRun: (id: string) => byId.get(id),
    listAgentRuns: (query) =>
      [...byId.values()].filter((run) => {
        if (
          query?.scopeType !== undefined &&
          run.scopeType !== query.scopeType
        ) {
          return false;
        }
        if (
          query?.runStatus !== undefined &&
          run.runStatus !== query.runStatus
        ) {
          return false;
        }
        return true;
      }),
    createAgentRun: vi.fn(),
    updateAgentRun: vi.fn((id: string, patch: Partial<TaskAgentRun>) => {
      const existing = byId.get(id);
      if (existing === undefined) throw new Error(`missing run ${id}`);
      byId.set(id, { ...existing, ...patch });
    }),
    appendQuarantinedFrame: vi.fn(),
    listEvents: vi.fn(() => []),
    appendEvent: vi.fn(),
    graph: vi.fn(() => {
      throw new Error('graph() not implemented in recovery-test store mock');
    }),
    snapshotGraph: vi.fn(() => ({ milestones: [], features: [], tasks: [] })),
    rehydrate: vi.fn(() => ({
      graph: { milestones: [], features: [], tasks: [] },
      openRuns: [...byId.values()],
      pendingEvents: [],
    })),
    setWorkerPid: vi.fn(),
    clearWorkerPid: vi.fn(),
    getLiveWorkerPids: vi.fn(() => []),
    appendInboxItem: vi.fn(),
    listInboxItems: vi.fn(() => []),
    resolveInboxItem: vi.fn(),
    setLastCommitSha: vi.fn(),
    setTrailerObservedAt: vi.fn(),
    getTrailerObservedAt: vi.fn(() => undefined),
    close: vi.fn(),
  };
}

type WorkerPidRegistryMock = WorkerPidRegistry & {
  set: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
};

function createPidRegistryMock(
  options: {
    entries?: Array<{ agentRunId: string; pid: number }>;
    isAlive?: (pid: number) => boolean;
  } = {},
): WorkerPidRegistryMock {
  const entries = [...(options.entries ?? [])];
  const registry: WorkerPidRegistryMock = {
    set: vi.fn((agentRunId: string, pid: number) => {
      const index = entries.findIndex(
        (entry) => entry.agentRunId === agentRunId,
      );
      if (index >= 0) {
        entries[index] = { agentRunId, pid };
        return;
      }
      entries.push({ agentRunId, pid });
    }),
    clear: vi.fn((agentRunId: string) => {
      const index = entries.findIndex(
        (entry) => entry.agentRunId === agentRunId,
      );
      if (index >= 0) {
        entries.splice(index, 1);
      }
    }),
    list: vi.fn(() => [...entries]),
    isAlive: vi.fn((pid: number) => options.isAlive?.(pid) ?? false),
  };
  return registry;
}

function createRuntimeMock(): RuntimePort & {
  dispatchTask: ReturnType<typeof vi.fn>;
  resumeTask: ReturnType<typeof vi.fn>;
} {
  return {
    dispatchTask: vi.fn(
      (
        _task,
        dispatch: {
          mode: 'start' | 'resume';
          agentRunId: string;
          sessionId?: string;
        },
      ) =>
        Promise.resolve(
          dispatch.mode === 'resume'
            ? {
                kind: 'resumed' as const,
                taskId: 't-1',
                agentRunId: dispatch.agentRunId,
                sessionId: dispatch.sessionId ?? 'sess-resumed',
              }
            : {
                kind: 'started' as const,
                taskId: 't-1',
                agentRunId: dispatch.agentRunId,
                sessionId: 'sess-started',
              },
        ),
    ),
    steerTask: vi.fn(),
    suspendTask: vi.fn(),
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
  };
}

function createPorts(
  runs: TaskAgentRun[],
  options: { pidRegistry?: WorkerPidRegistryMock } = {},
): {
  ports: OrchestratorPorts;
  store: Store & { updateAgentRun: ReturnType<typeof vi.fn> };
  runtime: RuntimePort & {
    dispatchTask: ReturnType<typeof vi.fn>;
    resumeTask: ReturnType<typeof vi.fn>;
  };
  graph: InMemoryFeatureGraph;
  pidRegistry: WorkerPidRegistryMock;
} {
  const graph = new InMemoryFeatureGraph();
  graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
  graph.createFeature({
    id: 'f-1',
    milestoneId: 'm-1',
    name: 'Feature 1',
    description: 'desc',
  });
  graph.createTask({
    id: 't-1',
    featureId: 'f-1',
    description: 'Task 1',
  });
  graph.editTask('t-1', { reservedWritePaths: ['src/a.ts'] });

  for (const taskId of new Set(runs.map((run) => run.scopeId))) {
    if (graph.tasks.has(taskId)) {
      continue;
    }
    graph.createTask({
      id: taskId,
      featureId: 'f-1',
      description: `Task ${taskId}`,
    });
  }

  const store = createStoreMock(runs) as Store & {
    updateAgentRun: ReturnType<typeof vi.fn>;
  };
  const runtime = createRuntimeMock();
  const ui: UiPort = {
    show: vi.fn(async () => {}),
    refresh: vi.fn(),
    dispose: vi.fn(),
  };
  const verification = {
    verifyFeature: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as OrchestratorPorts['verification'];
  const pidRegistry = options.pidRegistry ?? createPidRegistryMock();

  return {
    graph,
    store,
    runtime,
    pidRegistry,
    ports: {
      store,
      runtime,
      sessionStore: new InMemorySessionStore(),
      agents: {} as OrchestratorPorts['agents'],
      verification,
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
        removeWorktree: () => Promise.resolve(),
        deleteBranch: () => Promise.resolve(),
        pruneStaleWorktrees: () => Promise.resolve([]),
        sweepStaleLocks: vi.fn(() => Promise.resolve([])),
      },
      ui,
      config: { ...testGvcConfigDefaults(), tokenProfile: 'balanced' },
    },
  };
}

describe('RecoveryService', () => {
  it('resumes running task with persisted session id', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, runtime, store, graph, pidRegistry } = createPorts([run]);
    const service = new RecoveryService(ports, graph, pidRegistry);

    const summary = await service.recoverOrphanedRuns();

    expect(runtime.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-1',
      },
      expect.any(Object),
    );
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      sessionId: 'sess-1',
      restartCount: 1,
    });
    expect(summary).toEqual({
      resumedRuns: [
        {
          taskId: 't-1',
          agentRunId: run.id,
          sessionId: 'sess-1',
        },
      ],
      restartedRuns: [],
      attentionRuns: [],
    });
  });

  it('immediately restarts startup recovery runs when resume is not resumable', async () => {
    const run = makeTaskRun({
      id: 'run-task:t-1',
      runStatus: 'running',
      sessionId: 'sess-gone',
    });
    const { ports, runtime, store, graph, pidRegistry } = createPorts([run]);
    runtime.dispatchTask = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'not_resumable',
        taskId: 't-1',
        agentRunId: run.id,
        sessionId: 'sess-gone',
        reason: 'session_not_found',
      })
      .mockResolvedValueOnce({
        kind: 'started',
        taskId: 't-1',
        agentRunId: run.id,
        sessionId: 'sess-fresh',
      });
    ports.runtime.dispatchTask = runtime.dispatchTask;
    const service = new RecoveryService(ports, graph, pidRegistry);

    const summary = await service.recoverOrphanedRuns();

    expect(runtime.dispatchTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-gone',
      },
      expect.any(Object),
    );
    expect(runtime.dispatchTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'start',
        agentRunId: run.id,
      },
      expect.any(Object),
    );
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'running',
      owner: 'system',
      sessionId: 'sess-fresh',
      restartCount: 1,
    });
    expect(summary).toEqual({
      resumedRuns: [],
      restartedRuns: [
        {
          taskId: 't-1',
          agentRunId: run.id,
          sessionId: 'sess-fresh',
          reason: 'session_not_found',
        },
      ],
      attentionRuns: [],
    });
  });

  it('resets running task without session id to ready system ownership', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      owner: 'manual',
    });
    const { ports, runtime, store, graph, pidRegistry } = createPorts([run]);
    const service = new RecoveryService(ports, graph, pidRegistry);

    await service.recoverOrphanedRuns();

    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      restartCount: 1,
    });
  });

  it('checkpoints live manual waits, leaves checkpointed waits parked, and preserves retry waits', async () => {
    const runs = [
      makeTaskRun({
        id: 'run-retry',
        scopeId: 't-1',
        runStatus: 'retry_await',
        retryAt: 123,
      }),
      makeTaskRun({
        id: 'run-help-live',
        scopeId: 't-1',
        runStatus: 'await_response',
        owner: 'manual',
        sessionId: 'sess-help-live',
      }),
      makeTaskRun({
        id: 'run-approval-live',
        scopeId: 't-1',
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'sess-approval-live',
      }),
      makeTaskRun({
        id: 'run-help-checkpointed',
        scopeId: 't-1',
        runStatus: 'checkpointed_await_response',
        owner: 'manual',
        sessionId: 'sess-help-checkpointed',
      }),
      makeTaskRun({
        id: 'run-approval-checkpointed',
        scopeId: 't-1',
        runStatus: 'checkpointed_await_approval',
        owner: 'manual',
        sessionId: 'sess-approval-checkpointed',
      }),
    ];
    const { ports, runtime, store, graph, pidRegistry } = createPorts(runs);
    const service = new RecoveryService(ports, graph, pidRegistry);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchTask).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-help-live', {
      runStatus: 'checkpointed_await_response',
      owner: 'manual',
      sessionId: 'sess-help-live',
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-approval-live', {
      runStatus: 'checkpointed_await_approval',
      owner: 'manual',
      sessionId: 'sess-approval-live',
    });
    expect(store.updateAgentRun).not.toHaveBeenCalledWith(
      'run-help-checkpointed',
      expect.anything(),
    );
    expect(store.updateAgentRun).not.toHaveBeenCalledWith(
      'run-approval-checkpointed',
      expect.anything(),
    );
    expect(store.updateAgentRun).not.toHaveBeenCalledWith(
      'run-retry',
      expect.anything(),
    );
  });

  it('does not resume suspended task runs across restart', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, runtime, store, graph, pidRegistry } = createPorts([run]);
    const task = graph.tasks.get('t-1');
    assert(task !== undefined, 'missing task fixture');
    graph.tasks.set('t-1', {
      ...task,
      status: 'running',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      suspendedAt: 100,
      blockedByFeatureId: 'f-2',
    });
    const service = new RecoveryService(ports, graph, pidRegistry);

    await service.recoverOrphanedRuns();

    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: 'sess-1',
    });
  });

  it('does not resume cancelled suspended task runs across restart', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, runtime, store, graph, pidRegistry } = createPorts([run]);
    const task = graph.tasks.get('t-1');
    assert(task !== undefined, 'missing task fixture');
    graph.tasks.set('t-1', {
      ...task,
      status: 'cancelled',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      suspendedAt: 100,
      blockedByFeatureId: 'f-2',
    });
    const service = new RecoveryService(ports, graph, pidRegistry);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchTask).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
      sessionId: 'sess-1',
    });
  });

  it('clears dead persisted worker pids and reports dead orphaned managed worktrees', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-recovery-startup-'),
    );
    try {
      const run = makeTaskRun({ id: 'run-task:t-1' });
      const pidRegistry = createPidRegistryMock({
        entries: [{ agentRunId: run.id, pid: 101 }],
        isAlive: () => false,
      });
      const { ports, graph } = createPorts([run], { pidRegistry });
      const task = graph.tasks.get('t-1');
      assert(task !== undefined, 'missing task fixture');
      const branch = resolveTaskWorktreeBranch(task);
      const taskDir = path.join(root, worktreePath(branch));
      const metadataDir = path.join(root, '.git', 'worktrees', branch);
      const lockPath = path.join(metadataDir, 'index.lock');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.mkdir(metadataDir, { recursive: true });
      await fs.writeFile(lockPath, 'stale-task-lock');

      const service = new RecoveryService(ports, graph, pidRegistry, root);
      const report = await service.recoverStartupState();

      expect(pidRegistry.clear).toHaveBeenCalledWith(run.id);
      expect(report.liveWorkerPids).toEqual([]);
      expect(report.clearedDeadWorkerPids).toEqual([
        {
          agentRunId: run.id,
          pid: 101,
          taskId: 't-1',
        },
      ]);
      expect(report.clearedLocks).toContainEqual({
        kind: 'worktree_index_lock',
        path: lockPath,
        branch,
      });
      expect(report.orphanTaskWorktrees).toEqual([
        expect.objectContaining({
          taskId: 't-1',
          featureId: 'f-1',
          branch,
          path: taskDir,
          ownerState: 'dead',
          registered: true,
          hasMetadataIndexLock: true,
        }),
      ]);
      expect(report.requiresAttention).toBe(true);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains live persisted worker pids and avoids orphan findings for live managed worktrees', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-recovery-startup-'),
    );
    try {
      const run = makeTaskRun({ id: 'run-task:t-1' });
      const pidRegistry = createPidRegistryMock({
        entries: [{ agentRunId: run.id, pid: 202 }],
        isAlive: () => true,
      });
      const { ports, graph } = createPorts([run], { pidRegistry });
      const task = graph.tasks.get('t-1');
      assert(task !== undefined, 'missing task fixture');
      const branch = resolveTaskWorktreeBranch(task);
      const taskDir = path.join(root, worktreePath(branch));
      const metadataDir = path.join(root, '.git', 'worktrees', branch);
      const lockPath = path.join(metadataDir, 'index.lock');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.mkdir(metadataDir, { recursive: true });
      await fs.writeFile(lockPath, 'live-task-lock');

      const service = new RecoveryService(ports, graph, pidRegistry, root);
      const report = await service.recoverStartupState();

      expect(pidRegistry.clear).not.toHaveBeenCalled();
      expect(report.liveWorkerPids).toEqual([
        {
          agentRunId: run.id,
          pid: 202,
          taskId: 't-1',
        },
      ]);
      expect(report.clearedDeadWorkerPids).toEqual([]);
      expect(report.preservedLocks).toContainEqual({
        kind: 'worktree_index_lock',
        path: lockPath,
        branch,
      });
      expect(report.orphanTaskWorktrees).toEqual([]);
      expect(report.requiresAttention).toBe(false);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports managed task worktrees with no live pid as absent orphan candidates', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-recovery-startup-'),
    );
    try {
      const { ports, graph, pidRegistry } = createPorts([]);
      const task = graph.tasks.get('t-1');
      assert(task !== undefined, 'missing task fixture');
      const branch = resolveTaskWorktreeBranch(task);
      const taskDir = path.join(root, worktreePath(branch));
      const metadataDir = path.join(root, '.git', 'worktrees', branch);
      const lockPath = path.join(metadataDir, 'index.lock');
      await fs.mkdir(taskDir, { recursive: true });
      await fs.mkdir(metadataDir, { recursive: true });
      await fs.writeFile(lockPath, 'orphan-task-lock');

      const service = new RecoveryService(ports, graph, pidRegistry, root);
      const report = await service.recoverStartupState();

      expect(report.clearedDeadWorkerPids).toEqual([]);
      expect(report.clearedLocks).toContainEqual({
        kind: 'worktree_index_lock',
        path: lockPath,
        branch,
      });
      expect(report.orphanTaskWorktrees).toEqual([
        expect.objectContaining({
          taskId: 't-1',
          featureId: 'f-1',
          branch,
          path: taskDir,
          ownerState: 'absent',
          registered: true,
          hasMetadataIndexLock: true,
        }),
      ]);
      expect(report.requiresAttention).toBe(true);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves run recovery semantics through the startup recovery entrypoint', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-recovery-startup-'),
    );
    try {
      const runs = [
        makeTaskRun({
          id: 'run-running',
          scopeId: 't-1',
          runStatus: 'running',
          sessionId: 'sess-1',
        }),
        makeTaskRun({
          id: 'run-help-live',
          scopeId: 't-2',
          runStatus: 'await_response',
          owner: 'manual',
          sessionId: 'sess-help-live',
        }),
        makeTaskRun({
          id: 'run-approval-live',
          scopeId: 't-3',
          runStatus: 'await_approval',
          owner: 'manual',
          sessionId: 'sess-approval-live',
        }),
        makeTaskRun({
          id: 'run-help-checkpointed',
          scopeId: 't-4',
          runStatus: 'checkpointed_await_response',
          owner: 'manual',
          sessionId: 'sess-help-checkpointed',
        }),
        makeTaskRun({
          id: 'run-retry',
          scopeId: 't-5',
          runStatus: 'retry_await',
          retryAt: 123,
        }),
      ];
      const { ports, runtime, store, graph, pidRegistry } = createPorts(runs);
      const service = new RecoveryService(ports, graph, pidRegistry, root);

      await service.recoverStartupState();

      expect(runtime.dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't-1' }),
        {
          mode: 'resume',
          agentRunId: 'run-running',
          sessionId: 'sess-1',
        },
        expect.any(Object),
      );
      expect(store.updateAgentRun).toHaveBeenCalledWith('run-running', {
        sessionId: 'sess-1',
        restartCount: 1,
      });
      expect(store.updateAgentRun).toHaveBeenCalledWith('run-help-live', {
        runStatus: 'checkpointed_await_response',
        owner: 'manual',
        sessionId: 'sess-help-live',
      });
      expect(store.updateAgentRun).toHaveBeenCalledWith('run-approval-live', {
        runStatus: 'checkpointed_await_approval',
        owner: 'manual',
        sessionId: 'sess-approval-live',
      });
      expect(store.updateAgentRun).not.toHaveBeenCalledWith(
        'run-help-checkpointed',
        expect.anything(),
      );
      expect(store.updateAgentRun).not.toHaveBeenCalledWith(
        'run-retry',
        expect.anything(),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('writes recovery marker into canonical worktree directory before replay-backed startup resume', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gvc0-recovery-'));
    try {
      const run = makeTaskRun({
        runStatus: 'running',
        sessionId: 'sess-1',
      });
      const { ports, graph, pidRegistry, runtime } = createPorts([run]);
      const taskDir = path.join(
        root,
        '.gvc0',
        'worktrees',
        'feat-feature-1-1-1',
      );
      await fs.mkdir(taskDir, { recursive: true });
      const service = new RecoveryService(ports, graph, pidRegistry, root);

      await service.recoverStartupState();

      expect(runtime.dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't-1' }),
        {
          mode: 'resume',
          agentRunId: run.id,
          sessionId: 'sess-1',
        },
        expect.any(Object),
      );
      await expect(
        fs.readFile(path.join(taskDir, 'RECOVERY_REBASE'), 'utf-8'),
      ).resolves.toBe('feat-feature-1-1');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
