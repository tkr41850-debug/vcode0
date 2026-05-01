import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, Task } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import type { RuntimeUsageDelta } from '@runtime/contracts';
import { buildRetryPolicyConfig, decideRetry } from '@runtime/retry-policy';
import { describe, expect, it, vi } from 'vitest';
import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

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

function createRun(overrides: Partial<AgentRun> = {}): AgentRun {
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
  } as AgentRun;
}

function buildDeps(params?: {
  task?: Partial<Task>;
  run?: Partial<AgentRun>;
  observedAt?: number;
}) {
  const task = createTaskFixture({
    id: 't-1',
    featureId: 'f-1',
    status: 'running',
    collabControl: 'branch_open',
    ...(params?.task ?? {}),
  });
  const run = createRun(params?.run ?? {});
  const graph = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
    ],
    tasks: [task],
  });

  const store = {
    getAgentRun: vi.fn(() => run),
    updateAgentRun: vi.fn(),
    listAgentRuns: vi.fn(() => []),
    createAgentRun: vi.fn(),
    appendEvent: vi.fn(),
    listEvents: vi.fn(() => []),
    appendInboxItem: vi.fn(),
    listInboxItems: vi.fn(() => []),
    resolveInboxItem: vi.fn(),
    setLastCommitSha: vi.fn(),
    setTrailerObservedAt: vi.fn(),
    getTrailerObservedAt: vi.fn(() => params?.observedAt),
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
    config: testGvcConfigDefaults(),
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

  return {
    graph,
    task,
    run,
    ports,
    features,
    conflicts,
    summaries,
    locks: new ActiveLocks(),
  };
}

describe('handleSchedulerEvent — commit gate', () => {
  it('rejects submitted completion when no trailer-ok commit was observed', async () => {
    const { graph, ports, features, conflicts, summaries, locks } = buildDeps();

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'result',
          taskId: 't-1',
          agentRunId: 'run-1',
          result: { summary: 'done', filesChanged: [] },
          usage: makeUsage(),
          completionKind: 'submitted',
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

    expect(ports.store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task_completion_rejected_no_commit',
        entityId: 't-1',
      }),
    );
    expect(graph.tasks.get('t-1')).toMatchObject({
      status: 'ready',
      collabControl: 'branch_open',
    });
    expect(ports.store.updateAgentRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
      }),
    );
    expect(features.onTaskLanded).not.toHaveBeenCalled();
  });

  it('accepts submitted completion after a trailer-ok commit was observed', async () => {
    const { graph, ports, features, conflicts, summaries, locks } = buildDeps({
      observedAt: 123,
    });

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'result',
          taskId: 't-1',
          agentRunId: 'run-1',
          result: { summary: 'done', filesChanged: [] },
          usage: makeUsage(),
          completionKind: 'submitted',
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

    expect(ports.store.appendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task_completion_rejected_no_commit',
      }),
    );
    expect(graph.tasks.get('t-1')).toMatchObject({
      status: 'done',
      collabControl: 'merged',
    });
    expect(features.onTaskLanded).toHaveBeenCalledWith('t-1');
  });

  it('rejects submitted completion after trailer-missing commit only', async () => {
    const { graph, ports, features, conflicts, summaries, locks } = buildDeps();

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'commit_done',
          taskId: 't-1',
          agentRunId: 'run-1',
          sha: 'abc1234',
          trailerOk: false,
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

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'result',
          taskId: 't-1',
          agentRunId: 'run-1',
          result: { summary: 'done', filesChanged: [] },
          usage: makeUsage(),
          completionKind: 'submitted',
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

    expect(ports.store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'commit_trailer_missing' }),
    );
    expect(ports.store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task_completion_rejected_no_commit',
      }),
    );
    expect(graph.tasks.get('t-1')).toMatchObject({ status: 'ready' });
  });

  it('records trailerObservedAt on trailer-ok commit_done', async () => {
    const { graph, ports, features, conflicts, summaries, locks } = buildDeps();

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'commit_done',
          taskId: 't-1',
          agentRunId: 'run-1',
          sha: 'abc1234',
          trailerOk: true,
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

    expect(ports.store.setTrailerObservedAt).toHaveBeenCalledWith(
      'run-1',
      expect.any(Number),
    );
    expect(ports.store.setLastCommitSha).toHaveBeenCalledWith(
      'run-1',
      'abc1234',
    );
  });
});

describe('decideRetry — no_commit policy', () => {
  it('retries no_commit within budget', () => {
    const decision = decideRetry(
      new Error('no_commit: no trailer-ok commit observed'),
      1,
      buildRetryPolicyConfig({
        ...testGvcConfigDefaults(),
        tokenProfile: 'balanced' as const,
      }),
    );
    expect(decision.kind).toBe('retry');
  });

  it('escalates no_commit at max attempts', () => {
    const config = buildRetryPolicyConfig({
      ...testGvcConfigDefaults(),
      tokenProfile: 'balanced' as const,
      retryCap: 3,
    });
    const decision = decideRetry(
      new Error('no_commit: no trailer-ok commit observed'),
      3,
      config,
    );
    expect(decision.kind).toBe('escalate_inbox');
  });
});
