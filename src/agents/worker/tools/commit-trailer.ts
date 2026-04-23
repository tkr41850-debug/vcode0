/**
 * REQ-EXEC-02: commit trailer contract.
 *
 * Every `git commit` the worker runs MUST carry `gvc0-task-id` and
 * `gvc0-run-id` trailers so the merge-train reconciler can attribute each
 * SHA to a task/run. This module is pure — parsing, detection, and command
 * rewriting live here; I/O (spawn, git interpret-trailers) stays in the
 * run-command tool so this file can be unit-tested without a shell.
 *
 * === Commit trailer contract (plan 03-03) ===
 * Wave 3 (merge-train reconciler + commit_done consumer) relies on these
 * trailers being present on every worker-produced commit.
 */

/**
 * Detect whether `command` is an executable `git commit` invocation we
 * should rewrite. Heuristic:
 *   - First non-whitespace token is `git`.
 *   - Next token is `commit` (ignoring global flags like `-C <dir>` is not
 *     supported — plan owner accepted the scope, see RESEARCH §commit shim).
 *   - `git status` / `git log` / `git show` / `npm test` etc. are NOT
 *     rewritten.
 */
export function isGitCommitCommand(command: string): boolean {
  const tokens = tokenizeShell(command);
  if (tokens.length < 2) return false;
  const [first, second] = tokens;
  if (first !== 'git') return false;
  return second === 'commit';
}

/**
 * Return the command with `--trailer "gvc0-task-id=<taskId>"` and
 * `--trailer "gvc0-run-id=<agentRunId>"` appended when the command is a
 * `git commit` invocation. Idempotent: if both trailer tokens already
 * appear in the command, the command is returned unchanged.
 *
 * For non-`git commit` commands the input is returned unchanged.
 */
export function maybeInjectTrailer(
  command: string,
  taskId: string,
  agentRunId: string,
): string {
  if (!isGitCommitCommand(command)) return command;

  const taskTrailer = `gvc0-task-id=${taskId}`;
  const runTrailer = `gvc0-run-id=${agentRunId}`;

  const hasTaskTrailer = command.includes(taskTrailer);
  const hasRunTrailer = command.includes(runTrailer);
  if (hasTaskTrailer && hasRunTrailer) return command;

  const parts: string[] = [command];
  if (!hasTaskTrailer) {
    parts.push(`--trailer ${shellQuote(taskTrailer)}`);
  }
  if (!hasRunTrailer) {
    parts.push(`--trailer ${shellQuote(runTrailer)}`);
  }
  return parts.join(' ');
}

/**
 * Parse the output of `git interpret-trailers --parse` and assert both the
 * task-id and run-id trailers are present with the expected values. The
 * output format is one trailer per line: `key: value`.
 */
export function validateTrailers(
  parsedOutput: string,
  taskId: string,
  agentRunId: string,
): boolean {
  const lines = parsedOutput.split(/\r?\n/);
  let hasTask = false;
  let hasRun = false;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'gvc0-task-id' && value === taskId) hasTask = true;
    if (key === 'gvc0-run-id' && value === agentRunId) hasRun = true;
  }
  return hasTask && hasRun;
}

/**
 * Minimal POSIX shell tokenizer. Honors double- and single-quoted segments
 * so we don't treat `git commit -m "feat: commit"` as four tokens. This is
 * deliberately simpler than a full parser — worker prompts run commands we
 * control, not arbitrary user input.
 */
function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) continue;

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = '';
      }
      continue;
    }

    buf += ch;
  }

  if (buf.length > 0) tokens.push(buf);
  return tokens;
}

/** Double-quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}
