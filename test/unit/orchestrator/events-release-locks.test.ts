import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, Task } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import type { RuntimeUsageDelta } from '@runtime/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function buildDeps(params: { task: Task; run: AgentRun }) {
  const graph = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
    ],
    tasks: [params.task],
  });

  const store = {
    getAgentRun: vi.fn(() => params.run),
    updateAgentRun: vi.fn(),
    listAgentRuns: vi.fn(() => []),
    createAgentRun: vi.fn(),
    appendEvent: vi.fn(),
    listEvents: vi.fn(() => []),
  };

  const ports = {
    store,
    runtime: {
      dispatchTask: vi.fn(),
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
  } as unknown as OrchestratorPorts;

  const features = {
    onTaskLanded: vi.fn(),
    createIntegrationRepair: vi.fn(),
    completePhase: vi.fn(),
    completeIntegration: vi.fn(),
    failIntegration: vi.fn(),
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

  return { graph, ports, features, conflicts, summaries };
}

function makeUsage(): RuntimeUsageDelta {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usd: 0,
  };
}

describe('handleSchedulerEvent — lock release on terminal worker messages', () => {
  it('releases locks held by the run on result', async () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const run: AgentRun = {
      id: 'run-1',
      scopeType: 'task',
      scopeId: 't-1',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    const { graph, ports, features, conflicts, summaries } = buildDeps({
      task,
      run,
    });
    const locks = new ActiveLocks();
    locks.tryClaim({ agentRunId: 'run-1', taskId: 't-1', featureId: 'f-1' }, [
      'src/held.ts',
    ]);

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'result',
          taskId: 't-1',
          agentRunId: 'run-1',
          result: { summary: 'done', filesChanged: [] },
          usage: makeUsage(),
          completionKind: 'implicit',
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: locks,
      emitEmptyVerificationChecksWarning: () => {},
      cancelFeatureRunWork: () => Promise.resolve(),
      onShutdown: () => {},
    });

    const reclaim = locks.tryClaim(
      { agentRunId: 'run-other', taskId: 't-other', featureId: 'f-1' },
      ['src/held.ts'],
    );
    expect(reclaim.granted).toBe(true);
  });

  it('releases locks held by the run on error', async () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const run: AgentRun = {
      id: 'run-1',
      scopeType: 'task',
      scopeId: 't-1',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    const { graph, ports, features, conflicts, summaries } = buildDeps({
      task,
      run,
    });
    const locks = new ActiveLocks();
    locks.tryClaim({ agentRunId: 'run-1', taskId: 't-1', featureId: 'f-1' }, [
      'src/held.ts',
    ]);

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'error',
          taskId: 't-1',
          agentRunId: 'run-1',
          error: 'worker_exited: …',
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: locks,
      emitEmptyVerificationChecksWarning: () => {},
      cancelFeatureRunWork: () => Promise.resolve(),
      onShutdown: () => {},
    });

    const reclaim = locks.tryClaim(
      { agentRunId: 'run-other', taskId: 't-other', featureId: 'f-1' },
      ['src/held.ts'],
    );
    expect(reclaim.granted).toBe(true);
  });
});
