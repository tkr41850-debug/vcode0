import type { Feature } from '@core/types/index';
import type {
  FeatureBranchHandle,
  FeatureBranchRebaseResult,
  GitPort,
  TaskWorktreeHandle,
  TaskWorktreeRebaseResult,
} from '@git';
import type {
  OrchestratorPorts,
  Store,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import { describe, expect, it, vi } from 'vitest';

import { FeatureLifecycleCoordinator } from '../../../src/orchestrator/features/index.js';
import { createFeatureFixture } from '../../helpers/graph-builders.js';

function createMockStore(overrides: Partial<Store> = {}): Store {
  return {
    loadRecoveryState: vi.fn(
      async (): Promise<StoreRecoveryState> => ({
        milestones: [],
        features: [],
        tasks: [],
        agentRuns: [],
        dependencies: [],
      }),
    ),
    saveGraphState: vi.fn(async () => {}),
    getMilestone: vi.fn(async () => undefined),
    getFeature: vi.fn(async () => undefined),
    getTask: vi.fn(async () => undefined),
    getAgentRun: vi.fn(async () => undefined),
    listMilestones: vi.fn(async () => []),
    listFeatures: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listAgentRuns: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    updateMilestone: vi.fn(async () => {}),
    updateFeature: vi.fn(async () => {}),
    updateTask: vi.fn(async () => {}),
    createAgentRun: vi.fn(async () => {}),
    updateAgentRun: vi.fn(async () => {}),
    listDependencies: vi.fn(async () => []),
    saveDependency: vi.fn(async () => {}),
    removeDependency: vi.fn(async () => {}),
    appendEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

function createMockGit(overrides: Partial<GitPort> = {}): GitPort {
  return {
    createFeatureBranch: vi.fn(
      async (feature: Feature): Promise<FeatureBranchHandle> => ({
        featureId: feature.id,
        branchName: `feat-${feature.id}`,
        worktreePath: `/tmp/worktrees/feat-${feature.id}`,
      }),
    ),
    createTaskWorktree: vi.fn(
      async (): Promise<TaskWorktreeHandle> => ({
        taskId: 't-1',
        featureId: 'f-1',
        branchName: 'feat-f-1-task-t-1',
        worktreePath: '/tmp/worktrees/task-t-1',
        parentBranch: 'feat-f-1',
      }),
    ),
    mergeTaskWorktree: vi.fn(async () => {}),
    mergeFeatureBranch: vi.fn(async () => {}),
    rebaseTaskWorktree: vi.fn(
      async (): Promise<TaskWorktreeRebaseResult> => ({
        kind: 'rebased',
        taskId: 't-1',
        featureId: 'f-1',
        branchName: 'feat-f-1-task-t-1',
        worktreePath: '/tmp/worktrees/task-t-1',
      }),
    ),
    rebaseFeatureBranch: vi.fn(
      async (): Promise<FeatureBranchRebaseResult> => ({
        kind: 'rebased',
        featureId: 'f-1',
        branchName: 'feat-f-1',
        worktreePath: '/tmp/worktrees/feat-f-1',
      }),
    ),
    scanFeatureOverlap: vi.fn(async () => []),
    ...overrides,
  };
}

function createMockPorts(
  overrides: Partial<OrchestratorPorts> = {},
): OrchestratorPorts {
  return {
    store: createMockStore(),
    git: createMockGit(),
    runtime: {} as OrchestratorPorts['runtime'],
    agents: {} as OrchestratorPorts['agents'],
    ui: { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() },
    config: { tokenProfile: 'balanced' },
    ...overrides,
  };
}

describe('FeatureLifecycleCoordinator', () => {
  describe('openBranch', () => {
    it('calls git.createFeatureBranch with the feature', async () => {
      const git = createMockGit();
      const ports = createMockPorts({ git });
      const coordinator = new FeatureLifecycleCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-1' });

      await coordinator.openBranch(feature);

      expect(git.createFeatureBranch).toHaveBeenCalledWith(feature);
    });

    it('updates the feature collabControl to branched after opening', async () => {
      const store = createMockStore();
      const git = createMockGit();
      const ports = createMockPorts({ store, git });
      const coordinator = new FeatureLifecycleCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-1' });

      await coordinator.openBranch(feature);

      expect(store.updateFeature).toHaveBeenCalledWith('f-1', {
        featureBranch: 'feat-f-1',
      });
    });
  });

  describe('runFeatureCi', () => {
    it('runs verification and stores the result', async () => {
      const store = createMockStore();
      const ports = createMockPorts({
        store,
        config: {
          tokenProfile: 'balanced',
          verification: {
            feature: {
              checks: [{ description: 'test', command: 'npm test' }],
              timeoutSecs: 30,
              continueOnFail: false,
            },
          },
        },
      });
      const coordinator = new FeatureLifecycleCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-1' });

      await coordinator.runFeatureCi(feature);

      // Should have appended an event recording CI result
      expect(store.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'f-1',
          eventType: 'feature_ci',
        }),
      );
    });
  });

  describe('markAwaitingMerge', () => {
    it('sets mergeTrainEnteredAt on the feature', async () => {
      const store = createMockStore();
      const ports = createMockPorts({ store });
      const coordinator = new FeatureLifecycleCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-1' });

      await coordinator.markAwaitingMerge(feature);

      expect(store.updateFeature).toHaveBeenCalledWith(
        'f-1',
        expect.objectContaining({
          mergeTrainEnteredAt: expect.any(Number),
        }),
      );
    });
  });
});
