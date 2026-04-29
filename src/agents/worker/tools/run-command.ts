import { spawn } from 'node:child_process';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const parameters = Type.Object({
  command: Type.String({
    description: 'Shell command. Executed via `sh -c`.',
  }),
  timeoutMs: Type.Optional(
    Type.Number({
      description: 'Kill after this many ms. Default 60000.',
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

export function createRunCommandTool(
  workdir: string,
): AgentTool<typeof parameters, RunCommandDetails> {
  return {
    name: 'run_command',
    label: 'Run Command',
    description:
      'Run a shell command. Returns stdout, stderr, exit code. Prefer dedicated tools when one fits — read_file, write_file, edit_file, list_files, search_files, git_status, git_diff — bash matches training distribution but loses path-lock tracking.',
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const timeoutMs = params.timeoutMs ?? 60_000;
      const result = await runShell(params.command, workdir, timeoutMs, signal);

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
          command: params.command,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
        },
      };
    },
  };
}
