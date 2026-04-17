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
