import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Directories we never descend into during list/search walks. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.gvc0',
  'dist',
  'coverage',
]);

export interface WalkEntry {
  /** Path relative to the walk root, using POSIX separators. */
  rel: string;
  isDirectory: boolean;
  isFile: boolean;
}

/**
 * Walk `base/rel` yielding every entry whose name is not in {@link IGNORED_DIRS}.
 * When `recursive` is false, directory entries are yielded but not descended into.
 */
export async function* walkEntries(
  base: string,
  rel: string,
  recursive = true,
): AsyncGenerator<WalkEntry> {
  const entries = await fs.readdir(path.join(base, rel), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    const isDir = entry.isDirectory();
    const isFile = entry.isFile();
    yield { rel: entryRel, isDirectory: isDir, isFile };
    if (isDir && recursive) yield* walkEntries(base, entryRel, recursive);
  }
}

/**
 * Resolve a user-supplied path relative to `workdir` and assert it stays
 * inside the worktree. Prevents `../../etc/passwd` escapes from tool inputs.
 */
export function resolveInsideWorkdir(workdir: string, rel: string): string {
  const abs = path.resolve(workdir, rel);
  const root = path.resolve(workdir);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes worktree: ${rel}`);
  }
  return abs;
}
