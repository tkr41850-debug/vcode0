import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  FeaturePhaseAgentRun,
  Task,
  TaskAgentRun,
} from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import type { RunErrorLogInput } from '@runtime/error-log/index';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function buildDeps(params: { task?: Task; run: AgentRun }): {
  graph: InMemoryFeatureGraph;
  ports: OrchestratorPorts;
  features: FeatureLifecycleCoordinator;
  conflicts: ConflictCoordinator;
  summaries: SummaryCoordinator;
  recorded: RunErrorLogInput[];
} {
  const graph = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
    ],
    tasks: params.task !== undefined ? [params.task] : [],
  });

  const store = {
    getAgentRun: vi.fn(() => params.run),
    updateAgentRun: vi.fn(),
    listAgentRuns: vi.fn(() => []),
    createAgentRun: vi.fn(),
    appendEvent: vi.fn(),
    listEvents: vi.fn(() => []),
    appendInboxItem: vi.fn(() => ({
      id: 0,
      ts: 0,
      kind: 'semantic_failure' as const,
    })),
  };

  const recorded: RunErrorLogInput[] = [];

  const ports = {
    store,
    runtime: {
      dispatchTask: vi.fn(),
      dispatchRun: vi.fn(),
      steerTask: vi.fn(),
      suspendTask: vi.fn(),
      resumeTask: vi.fn(),
      respondToHelp: vi.fn(),
      decideApproval: vi.fn(),
      sendManualInput: vi.fn(),
      abortTask: vi.fn(),
      respondClaim: vi.fn(),
      idleWorkerCount: vi.fn(() => 1),
      stopAll: vi.fn(),
    },
    runErrorLogSink: {
      writeFirstFailure: vi.fn(async (input: RunErrorLogInput) => {
        recorded.push(input);
      }),
    },
  } as unknown as OrchestratorPorts;

  const features = {
    onTaskLanded: vi.fn(),
    rerouteToReplan: vi.fn(),
    completePhase: vi.fn(),
    completeIntegration: vi.fn(),
    beginNextIntegration: vi.fn(),
  } as unknown as FeatureLifecycleCoordinator;

  const conflicts = {
    reconcileSameFeatureTasks: vi.fn(() => Promise.resolve()),
    releaseCrossFeatureOverlap: vi.fn(() => Promise.resolve([])),
    resumeCrossFeatureTasks: vi.fn(() => Promise.resolve({ kind: 'resumed' })),
    clearCrossFeatureBlock: vi.fn(),
  } as unknown as ConflictCoordinator;

  const summaries = {
    completeSummary: vi.fn(),
    reconcilePostMerge: vi.fn(),
  } as unknown as SummaryCoordinator;

  return { graph, ports, features, conflicts, summaries, recorded };
}

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-1',
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

describe('handleSchedulerEvent — first-failure error log', () => {
  it('writes log on task error then transitions to retry_await', async () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const run = makeTaskRun({ restartCount: 0 });
    const { graph, ports, features, conflicts, summaries, recorded } =
      buildDeps({ task, run });

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'error',
          taskId: 't-1',
          agentRunId: 'run-1',
          error: 'ECONNRESET while reading',
          stack: 'Error: ECONNRESET while reading\n    at foo (/x.ts:1:1)',
          scopeRef: { kind: 'task', taskId: 't-1', featureId: 'f-1' },
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
      now: () => 1_000_000,
    });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    if (entry === undefined) throw new Error('no recorded entry');
    expect(entry.run.id).toBe('run-1');
    expect(entry.featureId).toBe('f-1');
    expect(entry.taskId).toBe('t-1');
    expect(entry.error.message).toBe('ECONNRESET while reading');
    expect(entry.error.stack).toBe(
      'Error: ECONNRESET while reading\n    at foo (/x.ts:1:1)',
    );
    expect(entry.synthesizedReason).toBeUndefined();

    const update = (
      ports.store.updateAgentRun as ReturnType<typeof vi.fn>
    ).mock.calls.find((call) => call[1]?.runStatus === 'retry_await');
    expect(update).toBeDefined();
  });

  it('still calls sink on second-attempt error (sink owns first-only gate)', async () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const run = makeTaskRun({ restartCount: 1 });
    const { graph, ports, features, conflicts, summaries, recorded } =
      buildDeps({ task, run });

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'error',
          taskId: 't-1',
          agentRunId: 'run-1',
          error: 'boom-again',
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    if (entry === undefined) throw new Error('no recorded entry');
    expect(entry.run.restartCount).toBe(1);
  });

  it('records synthesizedReason worker_exited for synthesized exits', async () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const run = makeTaskRun();
    const { graph, ports, features, conflicts, summaries, recorded } =
      buildDeps({ task, run });

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'error',
          taskId: 't-1',
          agentRunId: 'run-1',
          error: 'worker_exited: code=1 signal=null',
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    if (entry === undefined) throw new Error('no recorded entry');
    expect(entry.synthesizedReason).toBe('worker_exited');
    expect(entry.error.stack).toBeUndefined();
  });

  it('writes log on feature_phase_error with taskId undefined', async () => {
    const run = makeFeaturePhaseRun();
    const { graph, ports, features, conflicts, summaries, recorded } =
      buildDeps({ run });

    await handleSchedulerEvent({
      event: {
        type: 'feature_phase_error',
        featureId: 'f-1',
        phase: 'plan',
        error: 'planner exploded',
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    if (entry === undefined) throw new Error('no recorded entry');
    expect(entry.featureId).toBe('f-1');
    expect(entry.taskId).toBeUndefined();
    expect(entry.error.message).toBe('planner exploded');
    expect(entry.synthesizedReason).toBeUndefined();
  });
});
