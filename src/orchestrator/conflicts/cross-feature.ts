import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { Feature, FeatureId, Task } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { rebaseGitDir, rebaseTaskWorktree } from './git.js';
import {
  defaultTaskBranch,
  formatCrossFeatureTaskConflictSummary,
} from './helpers.js';
import type {
  CrossFeatureReconcileResolution,
  CrossFeatureReleaseResult,
  CrossFeatureTaskResolution,
} from './types.js';

interface CrossFeatureDeps {
  ports: OrchestratorPorts;
  graph?: FeatureGraph | undefined;
  cwd?: string | undefined;
}

export async function handleCrossFeatureOverlap(
  deps: CrossFeatureDeps,
  primary: Feature,
  secondary: Feature,
  tasks: Task[],
  overlapFiles: string[] = [],
): Promise<void> {
  const { graph, ports } = deps;
  if (graph !== undefined) {
    graph.editFeature(secondary.id, {
      runtimeBlockedByFeatureId: primary.id,
    });
  }

  const overlapFileSet = new Set(overlapFiles);
  for (const task of tasks) {
    if (
      task.featureId !== secondary.id ||
      task.status !== 'running' ||
      task.collabControl !== 'branch_open'
    ) {
      continue;
    }

    const taskOverlapFiles = (task.reservedWritePaths ?? []).filter((p) =>
      overlapFileSet.has(p),
    );

    graph?.transitionTask(task.id, {
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      suspendedAt: Date.now(),
      blockedByFeatureId: primary.id,
      ...(taskOverlapFiles.length > 0
        ? { suspendedFiles: taskOverlapFiles }
        : {}),
    });

    await ports.runtime.suspendTask(
      task.id,
      'cross_feature_overlap',
      taskOverlapFiles,
    );
  }
}

export async function releaseCrossFeatureOverlap(
  deps: CrossFeatureDeps,
  primaryFeatureId: FeatureId,
): Promise<CrossFeatureReleaseResult[]> {
  const { graph } = deps;
  if (graph === undefined) {
    return [];
  }

  const blockedFeatureIds = findBlockedFeatureIds(graph, primaryFeatureId);
  const results: CrossFeatureReleaseResult[] = [];

  for (const blockedFeatureId of blockedFeatureIds) {
    const blockedFeature = graph.features.get(blockedFeatureId);
    if (blockedFeature === undefined) {
      continue;
    }

    const resolution = await reconcileBlockedFeature(deps, blockedFeature);
    if (resolution.kind === 'blocked') {
      results.push({
        featureId: blockedFeatureId,
        blockedByFeatureId: primaryFeatureId,
        kind: 'blocked',
        ...(resolution.summary !== undefined
          ? { summary: resolution.summary }
          : {}),
      });
      continue;
    }

    if (resolution.kind === 'repair_needed') {
      results.push({
        featureId: blockedFeatureId,
        blockedByFeatureId: primaryFeatureId,
        kind: 'repair_needed',
        conflictedFiles: resolution.conflictedFiles,
        ...(resolution.summary !== undefined
          ? { summary: resolution.summary }
          : {}),
      });
      continue;
    }

    clearCrossFeatureBlock(graph, blockedFeatureId);
    const taskRelease = await resumeCrossFeatureTasks(deps, blockedFeatureId);
    if (taskRelease.kind === 'blocked') {
      graph.editFeature(blockedFeatureId, {
        runtimeBlockedByFeatureId: primaryFeatureId,
      });
      results.push({
        featureId: blockedFeatureId,
        blockedByFeatureId: primaryFeatureId,
        kind: 'blocked',
        summary: taskRelease.summary,
      });
      continue;
    }

    results.push({
      featureId: blockedFeatureId,
      blockedByFeatureId: primaryFeatureId,
      kind: 'resumed',
    });
  }

  return results;
}

export async function resumeCrossFeatureTasks(
  deps: CrossFeatureDeps,
  featureId: FeatureId,
): Promise<{ kind: 'resumed' } | { kind: 'blocked'; summary: string }> {
  const { graph, ports } = deps;
  if (graph === undefined) {
    return { kind: 'resumed' };
  }

  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    return {
      kind: 'blocked',
      summary: `Blocked feature missing from graph: ${featureId}`,
    };
  }
  if (feature.collabControl === 'cancelled') {
    return { kind: 'resumed' };
  }
  if (feature.runtimeBlockedByFeatureId !== undefined) {
    return {
      kind: 'blocked',
      summary: `Feature ${featureId} still blocked by ${feature.runtimeBlockedByFeatureId}`,
    };
  }

  for (const task of graph.tasks.values()) {
    if (
      task.featureId !== featureId ||
      task.status === 'cancelled' ||
      task.collabControl !== 'suspended' ||
      task.suspendReason !== 'cross_feature_overlap'
    ) {
      continue;
    }

    const resolution = await reconcileCrossFeatureTask(deps, feature, task);
    if (resolution.kind === 'blocked') {
      return {
        kind: 'blocked',
        summary:
          resolution.summary ??
          `Cross-feature task resume blocked for ${task.id}`,
      };
    }
    if (resolution.kind === 'resumed') {
      const resume = await ports.runtime.resumeTask(
        task.id,
        'cross_feature_rebase',
      );
      if (resume.kind === 'delivered') {
        graph.transitionTask(task.id, {
          collabControl: 'branch_open',
        });
      } else {
        graph.transitionTask(task.id, {
          status: 'ready',
          collabControl: 'branch_open',
        });
      }
      continue;
    }

    return {
      kind: 'blocked',
      summary: formatCrossFeatureTaskConflictSummary(
        task.id,
        resolution.context.conflictedFiles ?? [],
      ),
    };
  }

  return { kind: 'resumed' };
}

export function clearCrossFeatureBlock(
  graph: FeatureGraph | undefined,
  featureId: FeatureId,
): void {
  graph?.editFeature(featureId, {
    runtimeBlockedByFeatureId: undefined,
  });
}

function findBlockedFeatureIds(
  graph: FeatureGraph,
  primaryFeatureId: FeatureId,
): FeatureId[] {
  const blockedFeatureIds = new Set<FeatureId>();
  for (const feature of graph.features.values()) {
    if (
      feature.collabControl !== 'cancelled' &&
      feature.runtimeBlockedByFeatureId === primaryFeatureId
    ) {
      blockedFeatureIds.add(feature.id);
    }
  }

  for (const task of graph.tasks.values()) {
    if (
      task.status !== 'cancelled' &&
      task.collabControl === 'suspended' &&
      task.blockedByFeatureId === primaryFeatureId
    ) {
      blockedFeatureIds.add(task.featureId);
    }
  }

  return [...blockedFeatureIds].sort((a, b) => a.localeCompare(b));
}

async function reconcileBlockedFeature(
  deps: CrossFeatureDeps,
  feature: Feature,
): Promise<CrossFeatureReconcileResolution> {
  const featureDir = path.resolve(
    deps.cwd ?? process.cwd(),
    worktreePath(feature.featureBranch),
  );
  const rebase = await rebaseGitDir(featureDir, 'main');
  if (rebase.kind === 'clean') {
    return { kind: 'resumed' };
  }
  if (rebase.kind === 'blocked') {
    return {
      kind: 'blocked',
      summary: `Feature worktree missing for ${feature.id}`,
    };
  }

  return {
    kind: 'repair_needed',
    conflictedFiles: rebase.conflictedFiles,
    ...(rebase.summary !== undefined ? { summary: rebase.summary } : {}),
  };
}

async function reconcileCrossFeatureTask(
  deps: CrossFeatureDeps,
  feature: Feature,
  task: Task,
): Promise<CrossFeatureTaskResolution> {
  const taskBranch = task.worktreeBranch ?? defaultTaskBranch(task);
  const taskDir = path.resolve(
    deps.cwd ?? process.cwd(),
    worktreePath(taskBranch),
  );
  const rebaseTarget = feature.featureBranch;
  const rebase = await rebaseTaskWorktree(taskDir, rebaseTarget);
  if (rebase.kind === 'clean') {
    return { kind: 'resumed' };
  }
  if (rebase.kind === 'blocked') {
    return {
      kind: 'blocked',
      summary: `Task worktree missing for ${task.id}`,
    };
  }

  const files = task.suspendedFiles ?? [];
  const blockedByFeatureId = task.blockedByFeatureId;
  if (blockedByFeatureId === undefined) {
    return {
      kind: 'blocked',
      summary: `Blocked-by feature missing for ${task.id}`,
    };
  }

  return {
    kind: 'conflict',
    context: {
      kind: 'cross_feature_task_rebase',
      featureId: feature.id,
      taskId: task.id,
      taskBranch,
      rebaseTarget,
      blockedByFeatureId,
      pauseReason: 'cross_feature_overlap',
      files,
      conflictedFiles:
        rebase.conflictedFiles.length > 0 ? rebase.conflictedFiles : files,
      ...(task.reservedWritePaths !== undefined
        ? { reservedWritePaths: task.reservedWritePaths }
        : {}),
    },
  };
}
