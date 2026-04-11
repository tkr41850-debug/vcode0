import type { Task } from '@core/types/index';
import type {
  FeatureBranchRebaseResult,
  OverlapIncident,
  TaskWorktreeRebaseResult,
} from '@git';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function createMockPorts(
  overrides: Partial<OrchestratorPorts> = {},
): OrchestratorPorts {
  return {
    store: {} as OrchestratorPorts['store'],
    git: {
      rebaseTaskWorktree: vi.fn(
        async (task: Task): Promise<TaskWorktreeRebaseResult> => ({
          kind: 'rebased',
          taskId: task.id,
          featureId: 'f-1',
          branchName: `feat-f-1-task-${task.id}`,
          worktreePath: `.gvc0/worktrees/feat-f-1-task-${task.id}`,
        }),
      ),
      rebaseFeatureBranch: vi.fn(
        async (): Promise<FeatureBranchRebaseResult> => ({
          kind: 'rebased',
          featureId: 'f-1',
          branchName: 'feat-f-1',
          worktreePath: '.gvc0/worktrees/feat-f-1',
        }),
      ),
    } as unknown as OrchestratorPorts['git'],
    runtime: {
      resumeTask: vi.fn(async () => ({
        kind: 'delivered' as const,
        taskId: 't-1',
        agentRunId: 'run-1',
      })),
      steerTask: vi.fn(async () => ({
        kind: 'delivered' as const,
        taskId: 't-1',
        agentRunId: 'run-1',
      })),
    } as unknown as OrchestratorPorts['runtime'],
    agents: {} as OrchestratorPorts['agents'],
    ui: { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() },
    config: { tokenProfile: 'balanced' },
    ...overrides,
  };
}

describe('ConflictCoordinator', () => {
  describe('handleSameFeatureOverlap', () => {
    it('rebases non-dominant tasks and resumes them on success', async () => {
      const feature = createFeatureFixture({
        id: 'f-1',
        featureBranch: 'feat-f-1',
      });
      const tasks: Task[] = [
        createTaskFixture({ id: 't-1', featureId: 'f-1' }),
        createTaskFixture({ id: 't-2', featureId: 'f-1' }),
      ];
      const incident: OverlapIncident = {
        featureId: 'f-1',
        taskIds: ['t-1', 't-2'],
        files: ['src/shared.ts'],
        suspendReason: 'same_feature_overlap',
      };

      const ports = createMockPorts();
      const coordinator = new ConflictCoordinator(ports);

      await coordinator.handleSameFeatureOverlap(feature, incident, tasks);

      // t-1 is dominant (first in taskIds), so only t-2 should be rebased
      expect(ports.git.rebaseTaskWorktree).toHaveBeenCalledTimes(1);
      expect(ports.git.rebaseTaskWorktree).toHaveBeenCalledWith(
        tasks[1],
        feature,
      );
      expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
        't-2',
        'same_feature_rebase',
      );
    });

    it('steers task on conflict instead of resuming', async () => {
      const feature = createFeatureFixture({
        id: 'f-1',
        featureBranch: 'feat-f-1',
      });
      const tasks: Task[] = [
        createTaskFixture({ id: 't-1', featureId: 'f-1' }),
        createTaskFixture({ id: 't-2', featureId: 'f-1' }),
      ];
      const incident: OverlapIncident = {
        featureId: 'f-1',
        taskIds: ['t-1', 't-2'],
        files: ['src/shared.ts'],
        suspendReason: 'same_feature_overlap',
      };

      const conflictContext = {
        kind: 'same_feature_task_rebase' as const,
        featureId: 'f-1' as const,
        taskId: 't-2' as const,
        taskBranch: 'feat-f-1-task-t-2',
        rebaseTarget: 'feat-f-1',
        pauseReason: 'same_feature_overlap' as const,
        files: ['src/shared.ts'],
        conflictedFiles: ['src/shared.ts'],
      };

      const ports = createMockPorts({
        git: {
          rebaseTaskWorktree: vi.fn(
            async (): Promise<TaskWorktreeRebaseResult> => ({
              kind: 'conflicted',
              taskId: 't-2',
              featureId: 'f-1',
              branchName: 'feat-f-1-task-t-2',
              worktreePath: '.gvc0/worktrees/feat-f-1-task-t-2',
              conflictedFiles: ['src/shared.ts'],
              gitConflictContext: conflictContext,
            }),
          ),
        } as unknown as OrchestratorPorts['git'],
      });
      const coordinator = new ConflictCoordinator(ports);

      await coordinator.handleSameFeatureOverlap(feature, incident, tasks);

      expect(ports.runtime.steerTask).toHaveBeenCalledWith('t-2', {
        kind: 'conflict_steer',
        timing: 'immediate',
        gitConflictContext: conflictContext,
      });
      expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    });

    it('skips tasks not in the incident', async () => {
      const feature = createFeatureFixture({ id: 'f-1' });
      const tasks: Task[] = [
        createTaskFixture({ id: 't-1', featureId: 'f-1' }),
        createTaskFixture({ id: 't-3', featureId: 'f-1' }),
      ];
      const incident: OverlapIncident = {
        featureId: 'f-1',
        taskIds: ['t-1', 't-2'],
        files: ['src/shared.ts'],
        suspendReason: 'same_feature_overlap',
      };

      const ports = createMockPorts();
      const coordinator = new ConflictCoordinator(ports);

      await coordinator.handleSameFeatureOverlap(feature, incident, tasks);

      // t-3 is not in incident.taskIds, so should not be rebased
      expect(ports.git.rebaseTaskWorktree).not.toHaveBeenCalled();
    });
  });

  describe('handleCrossFeatureOverlap', () => {
    it('rebases secondary feature and resumes all tasks on success', async () => {
      const primary = createFeatureFixture({
        id: 'f-1',
        featureBranch: 'feat-f-1',
      });
      const secondary = createFeatureFixture({
        id: 'f-2',
        featureBranch: 'feat-f-2',
      });
      const tasks: Task[] = [
        createTaskFixture({ id: 't-3', featureId: 'f-2' }),
        createTaskFixture({ id: 't-4', featureId: 'f-2' }),
      ];

      const ports = createMockPorts({
        git: {
          rebaseFeatureBranch: vi.fn(
            async (): Promise<FeatureBranchRebaseResult> => ({
              kind: 'rebased',
              featureId: 'f-2',
              branchName: 'feat-f-2',
              worktreePath: '.gvc0/worktrees/feat-f-2',
            }),
          ),
        } as unknown as OrchestratorPorts['git'],
      });
      const coordinator = new ConflictCoordinator(ports);

      await coordinator.handleCrossFeatureOverlap(primary, secondary, tasks);

      expect(ports.git.rebaseFeatureBranch).toHaveBeenCalledWith(secondary);
      expect(ports.runtime.resumeTask).toHaveBeenCalledTimes(2);
      expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
        't-3',
        'cross_feature_rebase',
      );
      expect(ports.runtime.resumeTask).toHaveBeenCalledWith(
        't-4',
        'cross_feature_rebase',
      );
    });

    it('steers all tasks when feature rebase requires repair', async () => {
      const primary = createFeatureFixture({ id: 'f-1' });
      const secondary = createFeatureFixture({
        id: 'f-2',
        featureBranch: 'feat-f-2',
      });
      const tasks: Task[] = [
        createTaskFixture({ id: 't-3', featureId: 'f-2' }),
      ];

      const gitConflictContext = {
        kind: 'cross_feature_feature_rebase' as const,
        featureId: 'f-2' as const,
        blockedByFeatureId: 'f-1' as const,
        targetBranch: 'main',
        pauseReason: 'cross_feature_overlap' as const,
        files: ['README.md'],
        conflictedFiles: ['README.md'],
      };

      const ports = createMockPorts({
        git: {
          rebaseFeatureBranch: vi.fn(
            async (): Promise<FeatureBranchRebaseResult> => ({
              kind: 'repair_required',
              featureId: 'f-2',
              branchName: 'feat-f-2',
              worktreePath: '.gvc0/worktrees/feat-f-2',
              conflictedFiles: ['README.md'],
              gitConflictContext,
            }),
          ),
        } as unknown as OrchestratorPorts['git'],
      });
      const coordinator = new ConflictCoordinator(ports);

      await coordinator.handleCrossFeatureOverlap(primary, secondary, tasks);

      expect(ports.runtime.steerTask).toHaveBeenCalledWith('t-3', {
        kind: 'conflict_steer',
        timing: 'immediate',
        gitConflictContext,
      });
      expect(ports.runtime.resumeTask).not.toHaveBeenCalled();
    });
  });
});
