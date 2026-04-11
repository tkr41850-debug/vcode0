import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, TaskId } from '@core/types/index';
import type { OverlapIncident } from '@git/contracts';

function listChangedFiles(cwd: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const path = line.slice(3).trim();
      const renamedParts = path.split(' -> ');
      return renamedParts.at(-1) ?? path;
    });
}

function parseTaskId(
  branchName: string,
  featureBranch: string,
): TaskId | undefined {
  const prefix = `${featureBranch}-task-`;
  if (!branchName.startsWith(prefix)) {
    return undefined;
  }

  return branchName.slice(prefix.length) as TaskId;
}

export class OverlapScanner {
  scanFeatureOverlap(feature: Feature): Promise<OverlapIncident[]> {
    const worktreesDir = join(process.cwd(), '.gvc0', 'worktrees');
    const branchPrefix = `${feature.featureBranch}-task-`;
    const overlapsByFile = new Map<string, Set<TaskId>>();

    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(branchPrefix)) {
        continue;
      }

      const taskId = parseTaskId(entry.name, feature.featureBranch);
      if (!taskId) {
        continue;
      }

      for (const file of listChangedFiles(join(worktreesDir, entry.name))) {
        const existing = overlapsByFile.get(file) ?? new Set<TaskId>();
        existing.add(taskId);
        overlapsByFile.set(file, existing);
      }
    }

    const files = [...overlapsByFile.entries()]
      .filter(([, taskIds]) => taskIds.size > 1)
      .map(([file]) => file)
      .sort();

    if (files.length === 0) {
      return Promise.resolve([]);
    }

    const taskIds = new Set<TaskId>();
    for (const file of files) {
      for (const taskId of overlapsByFile.get(file) ?? []) {
        taskIds.add(taskId);
      }
    }

    return Promise.resolve([
      {
        featureId: feature.id,
        taskIds: [...taskIds].sort(),
        files,
        suspendReason: 'same_feature_overlap',
      },
    ]);
  }
}
