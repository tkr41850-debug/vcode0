/**
 * Plan 04-03, Task 4 — Scheduler Phase-4 E2E integration test.
 *
 * Two-feature end-to-end exercise of the Phase-4 scheduler:
 *   - f-up (upstream): one ready task `t-up-1`.
 *   - f-down (downstream): depends on f-up; one ready task `t-down-1`.
 *
 * The test drives the scheduler via its public `loop.step(now)` entry,
 * wiring a fake task-runtime that records every `dispatchTask(...)`
 * call. It asserts:
 *
 *   1. Before upstream merges, ONLY `t-up-1` is dispatched — `t-down-1`
 *      is gated by the upstream-merged rule added in Task 1.
 *   2. After flipping f-up to (work_complete, merged), `t-down-1`
 *      dispatches.
 *
 * This is the serial-FIFO scheduler's first real two-feature pass with
 * the feature-dep merged gate wired in. No worktrees are created; the
 * fake runtime returns `{ kind: 'started' }` synchronously. The point
 * is the scheduler decision path, not runtime plumbing.
 */
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  EventRecord,
  Feature,
  GvcConfig,
  Milestone,
  Task,
} from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  OrchestratorPorts,
  Store,
  UiPort,
} from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';

interface DispatchRecord {
  taskId: string;
  featureId: string;
}

function createStoreStub(): Store {
  const runs = new Map<string, AgentRun>();
  const events: EventRecord[] = [];

  return {
    getAgentRun: (id) => runs.get(id),
    listAgentRuns: (query?: AgentRunQuery) => {
      return [...runs.values()].filter((run) => {
        if (
          query?.scopeType !== undefined &&
          run.scopeType !== query.scopeType
        ) {
          return false;
        }
        if (query?.scopeId !== undefined && run.scopeId !== query.scopeId) {
          return false;
        }
        if (query?.phase !== undefined && run.phase !== query.phase) {
          return false;
        }
        if (
          query?.runStatus !== undefined &&
          run.runStatus !== query.runStatus
        ) {
          return false;
        }
        if (query?.owner !== undefined && run.owner !== query.owner) {
          return false;
        }
        return true;
      });
    },
    createAgentRun: (run) => {
      runs.set(run.id, run);
    },
    updateAgentRun: (runId, patch: AgentRunPatch) => {
      const existing = runs.get(runId);
      if (existing === undefined) {
        throw new Error(`agent run "${runId}" does not exist`);
      }
      runs.set(runId, { ...existing, ...patch } as AgentRun);
    },
    listEvents: (query?: EventQuery) => {
      return events.filter((e) => {
        if (query?.eventType !== undefined && e.eventType !== query.eventType) {
          return false;
        }
        if (query?.entityId !== undefined && e.entityId !== query.entityId) {
          return false;
        }
        return true;
      });
    },
    appendEvent: (event) => {
      events.push(event);
    },
    appendQuarantinedFrame: () => {
      /* no-op */
    },
    graph: () => {
      throw new Error('graph() not implemented in e2e store stub');
    },
    snapshotGraph: () => ({ milestones: [], features: [], tasks: [] }),
    rehydrate: () => ({
      graph: { milestones: [], features: [], tasks: [] },
      openRuns: [...runs.values()],
      pendingEvents: [...events],
    }),
    setWorkerPid: () => {
      /* no-op */
    },
    clearWorkerPid: () => {
      /* no-op */
    },
    getLiveWorkerPids: () => [],
    appendInboxItem: () => {
      /* no-op */
    },
    listInboxItems: () => [],
    resolveInboxItem: () => {
      /* no-op */
    },
    setLastCommitSha: () => {
      /* no-op */
    },
    setTrailerObservedAt: () => {
      /* no-op */
    },
    getTrailerObservedAt: () => undefined,
    close: () => {
      /* no-op */
    },
  };
}

function createRecordingRuntime(dispatched: DispatchRecord[]): RuntimePort {
  return {
    dispatchTask: (task: Task) => {
      dispatched.push({ taskId: task.id, featureId: task.featureId });
      return Promise.resolve({
        kind: 'started',
        taskId: task.id,
        agentRunId: `run-${task.id}`,
        sessionId: `sess-${task.id}`,
      });
    },
    steerTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    suspendTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    resumeTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    respondToHelp: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    decideApproval: (taskId) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    sendManualInput: (taskId) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    abortTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    respondClaim: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    idleWorkerCount: () => 4,
    stopAll: vi.fn(() => Promise.resolve()),
  };
}

function createUiStub(): UiPort {
  return {
    show: () => Promise.resolve(),
    refresh: () => {
      /* no-op */
    },
    dispose: () => {
      /* no-op */
    },
  };
}

function createConfig(): GvcConfig {
  return { ...testGvcConfigDefaults(), tokenProfile: 'balanced' as const };
}

function makeMilestone(): Milestone {
  return {
    id: 'm-1',
    name: 'M1',
    description: 'd',
    status: 'pending',
    order: 0,
  };
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f-x',
    milestoneId: 'm-1',
    orderInMilestone: 0,
    name: 'Feature',
    description: 'd',
    dependsOn: [],
    status: 'pending',
    workControl: 'executing',
    collabControl: 'branch_open',
    featureBranch: 'feat-feature-f-x',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-x',
    featureId: 'f-x',
    orderInFeature: 0,
    description: 'd',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
    ...overrides,
  };
}

function buildTwoFeatureGraph(): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [makeMilestone()],
    features: [
      makeFeature({
        id: 'f-up',
        name: 'Upstream',
        featureBranch: 'feat-upstream-f-up',
      }),
      makeFeature({
        id: 'f-down',
        name: 'Downstream',
        featureBranch: 'feat-downstream-f-down',
        dependsOn: ['f-up'],
      }),
    ],
    tasks: [
      makeTask({
        id: 't-up-1',
        featureId: 'f-up',
        description: 'upstream task',
      }),
      makeTask({
        id: 't-down-1',
        featureId: 'f-down',
        description: 'downstream task',
      }),
    ],
  });
}

function buildPorts(dispatched: DispatchRecord[]): OrchestratorPorts {
  const config = createConfig();
  return {
    store: createStoreStub(),
    runtime: createRecordingRuntime(dispatched),
    sessionStore: new InMemorySessionStore(),
    agents: {
      discussFeature: () => Promise.resolve({ summary: 'ok' }),
      researchFeature: () => Promise.resolve({ summary: 'ok' }),
      planFeature: () => Promise.reject(new Error('unexpected planFeature')),
      verifyFeature: () => Promise.resolve({ ok: true }),
      summarizeFeature: () => Promise.resolve({ summary: 'ok' }),
      replanFeature: () =>
        Promise.reject(new Error('unexpected replanFeature')),
    } as unknown as OrchestratorPorts['agents'],
    verification: new VerificationService({ config }),
    worktree: {
      ensureFeatureWorktree: () => Promise.resolve('/repo'),
      ensureTaskWorktree: () => Promise.resolve('/repo'),
      removeWorktree: () => Promise.resolve(),
      deleteBranch: () => Promise.resolve(),
      pruneStaleWorktrees: () => Promise.resolve([]),
      sweepStaleLocks: () => Promise.resolve([]),
    },
    ui: createUiStub(),
    config,
  };
}

describe('scheduler Phase-4 two-feature E2E', () => {
  let dispatched: DispatchRecord[];

  beforeEach(() => {
    dispatched = [];
  });

  it('gates downstream task until upstream feature is merged', async () => {
    const graph = buildTwoFeatureGraph();
    const ports = buildPorts(dispatched);
    const loop = new SchedulerLoop(graph, ports);

    // Tick 1 — upstream is branch_open (not merged). Scheduler should
    // dispatch `t-up-1` but NOT `t-down-1`.
    await loop.step(Date.now());

    expect(dispatched.map((d) => d.taskId)).toContain('t-up-1');
    expect(dispatched.map((d) => d.taskId)).not.toContain('t-down-1');

    // Flip upstream to work_complete + merged outside a tick (test-only
    // mutators bypass the tick guard; the scheduler sees the change on
    // its next step).
    graph.__enterTick();
    try {
      // Transition `f-up` through valid work states: executing →
      // work_complete, and collab branch_open → merged.
      // transitionFeature requires semantically valid transitions; we
      // bypass that by re-writing the map directly — this test is
      // asserting the readiness gate, not the transition validator.
      const feat = graph.features.get('f-up');
      if (feat === undefined) throw new Error('f-up missing');
      graph.features.set('f-up', {
        ...feat,
        workControl: 'work_complete',
        collabControl: 'merged',
      });
      // Also flip the upstream task to 'done' since tasks can't dispatch
      // again after a restart (the task is now in running state after
      // tick 1, but we want to focus on the downstream gate).
      const upTask = graph.tasks.get('t-up-1');
      if (upTask !== undefined) {
        graph.tasks.set('t-up-1', { ...upTask, status: 'done' });
      }
    } finally {
      graph.__leaveTick();
    }

    // Tick 2 — upstream now merged; downstream task should now
    // dispatch.
    await loop.step(Date.now());

    expect(dispatched.map((d) => d.taskId)).toContain('t-down-1');
  });

  it('does not gate tasks whose feature has no feature-deps', async () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [makeMilestone()],
      features: [
        makeFeature({
          id: 'f-solo',
          name: 'Solo',
          featureBranch: 'feat-solo-f-solo',
        }),
      ],
      tasks: [
        makeTask({
          id: 't-solo-1',
          featureId: 'f-solo',
          description: 'solo task',
        }),
      ],
    });
    const ports = buildPorts(dispatched);
    const loop = new SchedulerLoop(graph, ports);

    await loop.step(Date.now());

    expect(dispatched.map((d) => d.taskId)).toContain('t-solo-1');
  });
});
