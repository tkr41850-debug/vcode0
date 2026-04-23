import { InMemoryFeatureGraph } from '@core/graph/index';
import type { Feature, Task } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleClaimLock } from '@orchestrator/scheduler/claim-lock-handler';
import type {
  RuntimePort,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function createConflictSpy() {
  const handleSameFeatureOverlap = vi.fn(() => Promise.resolve());
  const handleCrossFeatureOverlap = vi.fn(() => Promise.resolve());
  const coordinator = {
    handleSameFeatureOverlap,
    handleCrossFeatureOverlap,
  } as unknown as ConflictCoordinator;
  return { coordinator, handleSameFeatureOverlap, handleCrossFeatureOverlap };
}

function createRuntimeSpy() {
  const respondClaim = vi.fn((taskId: string) =>
    Promise.resolve({
      kind: 'delivered' as const,
      taskId,
      agentRunId: '',
    }),
  );
  const runtime = { respondClaim } as unknown as RuntimePort;
  return { runtime, respondClaim };
}

function buildGraph(features: Feature[], tasks: Task[]): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features,
    tasks,
  });
}

describe('handleClaimLock', () => {
  const makeClaimMessage = (
    overrides: Partial<
      Extract<WorkerToOrchestratorMessage, { type: 'claim_lock' }>
    > = {},
  ): Extract<WorkerToOrchestratorMessage, { type: 'claim_lock' }> => ({
    type: 'claim_lock',
    taskId: 't-2',
    agentRunId: 'run-2',
    claimId: 'claim-xyz',
    paths: ['src/shared.ts'],
    ...overrides,
  });

  it('grants an uncontested claim and does not invoke conflict coordinator', async () => {
    const features = [
      createFeatureFixture({ id: 'f-1', workControl: 'executing' }),
    ];
    const tasks = [
      createTaskFixture({
        id: 't-1',
        featureId: 'f-1',
        status: 'running',
        collabControl: 'branch_open',
      }),
    ];
    const graph = buildGraph(features, tasks);
    const locks = new ActiveLocks();
    const { coordinator, handleSameFeatureOverlap, handleCrossFeatureOverlap } =
      createConflictSpy();
    const { runtime, respondClaim } = createRuntimeSpy();

    await handleClaimLock(
      { graph, locks, conflicts: coordinator, runtime },
      makeClaimMessage({
        taskId: 't-1',
        agentRunId: 'run-1',
      }),
    );

    expect(respondClaim).toHaveBeenCalledWith('t-1', {
      claimId: 'claim-xyz',
      kind: 'granted',
    });
    expect(handleSameFeatureOverlap).not.toHaveBeenCalled();
    expect(handleCrossFeatureOverlap).not.toHaveBeenCalled();
  });

  it('denies a same-feature conflict and calls handleSameFeatureOverlap', async () => {
    const feature = createFeatureFixture({
      id: 'f-1',
      workControl: 'executing',
    });
    const holderTask = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
      reservedWritePaths: ['src/shared.ts'],
    });
    const claimantTask = createTaskFixture({
      id: 't-2',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
      reservedWritePaths: ['src/shared.ts'],
    });
    const graph = buildGraph([feature], [holderTask, claimantTask]);
    const locks = new ActiveLocks();
    locks.tryClaim({ agentRunId: 'run-1', taskId: 't-1', featureId: 'f-1' }, [
      'src/shared.ts',
    ]);
    const { coordinator, handleSameFeatureOverlap, handleCrossFeatureOverlap } =
      createConflictSpy();
    const { runtime, respondClaim } = createRuntimeSpy();

    await handleClaimLock(
      { graph, locks, conflicts: coordinator, runtime },
      makeClaimMessage({
        taskId: 't-2',
        agentRunId: 'run-2',
        paths: ['src/shared.ts'],
      }),
    );

    expect(respondClaim).toHaveBeenCalledWith('t-2', {
      claimId: 'claim-xyz',
      kind: 'denied',
      deniedPaths: ['src/shared.ts'],
    });
    expect(handleSameFeatureOverlap).toHaveBeenCalledTimes(1);
    expect(handleCrossFeatureOverlap).not.toHaveBeenCalled();
    const [featureArg, incidentArg] = handleSameFeatureOverlap.mock
      .calls[0] as unknown as [
      Feature,
      { featureId: string; taskIds: string[] },
    ];
    expect(featureArg).toBe(feature);
    expect(incidentArg).toMatchObject({
      featureId: 'f-1',
      files: ['src/shared.ts'],
      suspendReason: 'same_feature_overlap',
    });
    expect(new Set(incidentArg.taskIds)).toEqual(new Set(['t-1', 't-2']));
  });

  it('denies a cross-feature conflict and calls handleCrossFeatureOverlap', async () => {
    const featureA = createFeatureFixture({
      id: 'f-1',
      workControl: 'executing',
    });
    const featureB = createFeatureFixture({
      id: 'f-2',
      workControl: 'executing',
    });
    const holderTask = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const claimantTask = createTaskFixture({
      id: 't-2',
      featureId: 'f-2',
      status: 'running',
      collabControl: 'branch_open',
    });
    const graph = buildGraph([featureA, featureB], [holderTask, claimantTask]);
    const locks = new ActiveLocks();
    locks.tryClaim({ agentRunId: 'run-1', taskId: 't-1', featureId: 'f-1' }, [
      'src/shared.ts',
    ]);
    const { coordinator, handleSameFeatureOverlap, handleCrossFeatureOverlap } =
      createConflictSpy();
    const { runtime, respondClaim } = createRuntimeSpy();

    await handleClaimLock(
      { graph, locks, conflicts: coordinator, runtime },
      makeClaimMessage({
        taskId: 't-2',
        agentRunId: 'run-2',
        paths: ['src/shared.ts'],
      }),
    );

    expect(respondClaim).toHaveBeenCalledWith('t-2', {
      claimId: 'claim-xyz',
      kind: 'denied',
      deniedPaths: ['src/shared.ts'],
    });
    expect(handleCrossFeatureOverlap).toHaveBeenCalledTimes(1);
    expect(handleSameFeatureOverlap).not.toHaveBeenCalled();
    const [primary, secondary, _tasks, files] = handleCrossFeatureOverlap.mock
      .calls[0] as unknown as [Feature, Feature, Task[], string[]];
    expect([primary.id, secondary.id].sort()).toEqual(['f-1', 'f-2']);
    expect(files).toEqual(['src/shared.ts']);
  });

  it('silently drops the claim when the claimant task is not in the graph', async () => {
    const graph = buildGraph([], []);
    const locks = new ActiveLocks();
    const { coordinator, handleSameFeatureOverlap, handleCrossFeatureOverlap } =
      createConflictSpy();
    const { runtime, respondClaim } = createRuntimeSpy();

    await handleClaimLock(
      { graph, locks, conflicts: coordinator, runtime },
      makeClaimMessage({ taskId: 't-missing' }),
    );

    expect(respondClaim).not.toHaveBeenCalled();
    expect(handleSameFeatureOverlap).not.toHaveBeenCalled();
    expect(handleCrossFeatureOverlap).not.toHaveBeenCalled();
  });
});
