import * as fs from 'node:fs/promises';

import { simpleGit } from 'simple-git';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function rebaseTaskWorktree(
  taskDir: string,
  rebaseTarget: string,
): Promise<
  | { kind: 'clean' }
  | { kind: 'blocked' }
  | { kind: 'conflict'; conflictedFiles: string[] }
> {
  return rebaseGitDir(taskDir, rebaseTarget);
}

export type SquashMergeOutcome =
  | { ok: true; sha: string }
  | { ok: true; alreadyMerged: true; sha: string }
  | { ok: false; conflict: true; conflictedFiles: string[] };

export async function squashMergeTaskIntoFeature(
  taskBranch: string,
  featureBranch: string,
  featureWorktreePath: string,
  commitMessage: string,
): Promise<SquashMergeOutcome> {
  const git = simpleGit(featureWorktreePath);

  const currentBranch = (
    await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])
  ).trim();
  if (currentBranch !== featureBranch) {
    await git.raw(['checkout', featureBranch]);
  }

  const mergeBase = (
    await git.raw(['merge-base', featureBranch, taskBranch])
  ).trim();
  const taskTip = (await git.raw(['rev-parse', taskBranch])).trim();
  if (mergeBase === taskTip) {
    const sha = (await git.raw(['rev-parse', 'HEAD'])).trim();
    return { ok: true, alreadyMerged: true, sha };
  }

  let mergeThrew = false;
  try {
    await git.raw(['merge', '--squash', taskBranch]);
  } catch {
    mergeThrew = true;
  }

  const status = await git.status();
  if (status.conflicted.length > 0) {
    const conflictedFiles = [...status.conflicted];
    try {
      await git.raw(['merge', '--abort']);
    } catch {
      // no active merge state; fall through
    }
    // ensure working tree is clean even if --abort was a no-op
    try {
      await git.raw(['reset', '--hard', 'HEAD']);
    } catch {
      // tolerate; nothing actionable
    }
    return { ok: false, conflict: true, conflictedFiles };
  }

  if (mergeThrew) {
    // Non-conflict failure (corrupt repo, invalid ref) — surface raw error.
    await git.raw(['merge', '--squash', taskBranch]);
  }

  if (
    status.staged.length === 0 &&
    status.created.length === 0 &&
    status.deleted.length === 0 &&
    status.modified.length === 0 &&
    status.renamed.length === 0
  ) {
    const sha = (await git.raw(['rev-parse', 'HEAD'])).trim();
    return { ok: true, alreadyMerged: true, sha };
  }

  await git.raw(['commit', '-m', commitMessage]);
  const sha = (await git.raw(['rev-parse', 'HEAD'])).trim();
  return { ok: true, sha };
}

export async function rebaseGitDir(
  gitDir: string,
  rebaseTarget: string,
): Promise<
  | { kind: 'clean' }
  | { kind: 'blocked' }
  | { kind: 'conflict'; conflictedFiles: string[]; summary?: string }
> {
  if (!(await fileExists(gitDir))) {
    return { kind: 'blocked' };
  }

  const git = simpleGit(gitDir);
  const dirtyFiles = await readDirtyFiles(git);
  if (dirtyFiles.length > 0) {
    return {
      kind: 'conflict',
      conflictedFiles: dirtyFiles,
      summary: 'Feature worktree has local changes before rebase',
    };
  }

  try {
    await git.rebase([rebaseTarget]);
    return { kind: 'clean' };
  } catch {
    const conflictedFiles = await readConflictedFiles(git);
    await abortRebase(git);
    const postAbortDirtyFiles = await readDirtyFiles(git);
    return {
      kind: 'conflict',
      conflictedFiles:
        conflictedFiles.length > 0 ? conflictedFiles : postAbortDirtyFiles,
      ...(postAbortDirtyFiles.length > 0
        ? { summary: 'Feature worktree still dirty after rebase abort' }
        : {}),
    };
  }
}

export async function abortRebase(
  git: ReturnType<typeof simpleGit>,
): Promise<void> {
  try {
    await git.raw(['rebase', '--abort']);
  } catch {
    // No active rebase to abort or git already cleaned up.
  }
}

export async function readConflictedFiles(
  git: ReturnType<typeof simpleGit>,
): Promise<string[]> {
  const diff = await git.raw(['diff', '--name-only', '--diff-filter=U']);
  const files = diff
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (files.length > 0) {
    return files;
  }

  const status = await git.status();
  return status.conflicted;
}

export async function readDirtyFiles(
  git: ReturnType<typeof simpleGit>,
): Promise<string[]> {
  const status = await git.status();
  return [
    ...status.not_added,
    ...status.created,
    ...status.deleted,
    ...status.modified,
    ...status.renamed.map((entry) => entry.to),
  ];
}
