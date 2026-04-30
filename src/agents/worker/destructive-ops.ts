/**
 * Pure regex test for destructive shell commands the worker should not run
 * without operator approval. Patterns are anchored with `\b` so flag-style
 * variants like `--force-with-lease` don't match `--force`. The set is
 * deliberately narrow: only operations that destroy committed work or
 * rewrite shared history are blocked here.
 */

export interface DestructiveCommandMatch {
  match: true;
  pattern: string;
}

export interface DestructiveCommandMiss {
  match: false;
}

export type DestructiveCommandResult =
  | DestructiveCommandMatch
  | DestructiveCommandMiss;

interface PatternEntry {
  label: string;
  regex: RegExp;
}

const PATTERNS: ReadonlyArray<PatternEntry> = [
  {
    label: 'git push --force',
    regex: /\bgit\s+push\s+(?:.*\s)?(?:-f\b|--force(?!-with-lease)\b)/,
  },
  {
    label: 'git branch -D',
    regex: /\bgit\s+branch\s+(?:.*\s)?-D\b/,
  },
  {
    label: 'git reset --hard',
    regex: /\bgit\s+reset\s+(?:.*\s)?--hard\b/,
  },
];

export function isDestructiveCommand(
  command: string,
): DestructiveCommandResult {
  for (const entry of PATTERNS) {
    if (entry.regex.test(command)) {
      return { match: true, pattern: entry.label };
    }
  }
  return { match: false };
}
