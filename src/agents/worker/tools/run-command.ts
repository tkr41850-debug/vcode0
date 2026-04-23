import { spawn } from 'node:child_process';

import {
  isGitCommitCommand,
  maybeInjectTrailer,
  validateTrailers,
} from '@agents/worker/tools/commit-trailer';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  command: Type.String({
    description:
      'Shell command to run. Executed via `sh -c` inside the worktree.',
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        'Kill the command after this many milliseconds. Default 60000.',
    }),
  ),
});

interface RunCommandDetails {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Per-stream capture cap. Prevents OOM from chatty builds / `cat bigfile`. */
const MAX_STREAM_BYTES = 1 * 1024 * 1024;

/**
 * REQ-EXEC-02: callback the run-command tool fires after a `git commit`
 * completes (exit 0) and we've asserted the required trailers. Wires into
 * the worker runtime to emit a `commit_done` IPC frame.
 */
export interface CommitDoneEmitter {
  (sha: string, trailerOk: boolean): void;
}

export interface RunCommandDeps {
  /** Absolute path to the task's git worktree. */
  workdir: string;
  /** REQ-EXEC-02: task id for `gvc0-task-id` trailer injection. */
  taskId?: string;
  /** REQ-EXEC-02: agent run id for `gvc0-run-id` trailer injection. */
  agentRunId?: string;
  /** Called after a successful `git commit` with SHA + trailer validation result. */
  onCommitDone?: CommitDoneEmitter;
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `detached: true` puts the shell in its own process group so we can
    // signal the whole group on timeout/abort — otherwise orphaned
    // grandchildren (e.g. `sleep` under `sh -c`) keep the stdio pipes open
    // and `close` never fires.
    const child = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length >= MAX_STREAM_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const remaining = MAX_STREAM_BYTES - stdout.length;
      const chunk = c.toString('utf-8');
      if (chunk.length <= remaining) {
        stdout += chunk;
      } else {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length >= MAX_STREAM_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = MAX_STREAM_BYTES - stderr.length;
      const chunk = c.toString('utf-8');
      if (chunk.length <= remaining) {
        stderr += chunk;
      } else {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      }
    });

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // group may already be gone
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      killGroup('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: sig,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

/** Spawn helper that captures stdout+stderr and returns exit code. */
function runQuick(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export function createRunCommandTool(
  deps: RunCommandDeps | string,
): AgentTool<typeof parameters, RunCommandDetails> {
  // Back-compat: older callers passed a bare workdir string; normalize.
  const cfg: RunCommandDeps =
    typeof deps === 'string' ? { workdir: deps } : deps;
  return {
    name: 'run_command',
    label: 'Run Command',
    description:
      'Run a shell command inside the task worktree. Returns stdout, stderr, and the exit code.',
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const timeoutMs = params.timeoutMs ?? 60_000;

      // === Commit trailer + commit_done (plan 03-03) ===
      // Rewrite git-commit invocations so every worker-produced commit
      // carries the required trailers. `maybeInjectTrailer` is a no-op for
      // every other command (git status, git log, npm test, …).
      const needsTrailerRewrite =
        isGitCommitCommand(params.command) &&
        cfg.taskId !== undefined &&
        cfg.agentRunId !== undefined;
      const rewritten = needsTrailerRewrite
        ? maybeInjectTrailer(params.command, cfg.taskId!, cfg.agentRunId!)
        : params.command;

      const result = await runShell(rewritten, cfg.workdir, timeoutMs, signal);

      // Only on a clean `git commit` do we validate + emit `commit_done`.
      if (
        needsTrailerRewrite &&
        result.exitCode === 0 &&
        !result.timedOut &&
        cfg.onCommitDone !== undefined
      ) {
        try {
          const shaRes = await runQuick(
            ['git', 'rev-parse', 'HEAD'],
            cfg.workdir,
          );
          const sha = shaRes.stdout.trim();
          if (sha.length > 0) {
            const logRes = await runQuick(
              ['git', 'log', '-1', '--pretty=%B', sha],
              cfg.workdir,
            );
            const trailerRes = await runQuick(
              ['git', 'interpret-trailers', '--parse'],
              cfg.workdir,
            );
            // `git interpret-trailers --parse` needs stdin — when we can't
            // feed it (no-TTY child), fall back to scanning the raw commit
            // message for the trailer lines.
            const trailerSource =
              trailerRes.stdout.length > 0 ? trailerRes.stdout : logRes.stdout;
            const trailerOk = validateTrailers(
              trailerSource,
              cfg.taskId!,
              cfg.agentRunId!,
            );
            cfg.onCommitDone(sha, trailerOk);
          }
        } catch {
          // Post-commit inspection is best-effort — swallow so the agent
          // keeps going even if git is momentarily unhappy.
        }
      }

      const statusLine = result.timedOut
        ? `[timed out after ${timeoutMs}ms]`
        : `[exit ${result.exitCode ?? 'null'}${
            result.signal !== null ? ` signal=${result.signal}` : ''
          }]`;

      const stdoutBlock =
        result.stdout.length > 0
          ? `---- stdout ----\n${result.stdout}${result.stdoutTruncated ? '\n[stdout truncated]' : ''}`
          : '';
      const stderrBlock =
        result.stderr.length > 0
          ? `---- stderr ----\n${result.stderr}${result.stderrTruncated ? '\n[stderr truncated]' : ''}`
          : '';
      const body = [statusLine, stdoutBlock, stderrBlock]
        .filter((s) => s.length > 0)
        .join('\n');

      return {
        content: [{ type: 'text', text: body }],
        details: {
          command: rewritten,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
        },
      };
    },
  };
}
