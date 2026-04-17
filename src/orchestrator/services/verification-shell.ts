import { spawn } from 'node:child_process';

import type { VerificationCheck } from '@core/types/index';

export interface VerificationCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const MAX_STREAM_BYTES = 8 * 1024;
const MAX_VERIFICATION_SUMMARY_CHARS = 16 * 1024;

interface StreamCaptureResult {
  value: string;
  truncated: boolean;
}

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  return Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8');
}

function appendStreamChunk(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): StreamCaptureResult {
  const currentBytes = Buffer.byteLength(current, 'utf-8');
  if (currentBytes >= maxBytes) {
    return {
      value: current,
      truncated: true,
    };
  }

  const remainingBytes = maxBytes - currentBytes;
  const text = chunk.toString('utf-8');
  const slice = truncateUtf8ToBytes(text, remainingBytes);

  return {
    value: `${current}${slice}`,
    truncated: slice.length < text.length,
  };
}

function formatCommandStatus(
  result: VerificationCommandResult,
  timeoutMs: number,
): string {
  if (result.timedOut) {
    return `[timed out after ${timeoutMs}ms]`;
  }

  if (result.signal !== null) {
    return `[exit ${result.exitCode ?? 'null'} signal=${result.signal}]`;
  }

  return `[exit ${result.exitCode ?? 'null'}]`;
}

function formatOutputBlock(
  label: 'stdout' | 'stderr',
  output: string,
  truncated: boolean,
): string {
  if (output.length === 0) {
    return '';
  }

  const suffix = truncated ? `\n[${label} truncated]` : '';
  return `---- ${label} ----\n${output}${suffix}`;
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<VerificationCommandResult> {
  return new Promise((resolve, reject) => {
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

    child.stdout?.on('data', function handleStdout(chunk: Buffer) {
      const capture = appendStreamChunk(stdout, chunk, MAX_STREAM_BYTES);
      stdout = capture.value;
      stdoutTruncated ||= capture.truncated;
    });

    child.stderr?.on('data', function handleStderr(chunk: Buffer) {
      const capture = appendStreamChunk(stderr, chunk, MAX_STREAM_BYTES);
      stderr = capture.value;
      stderrTruncated ||= capture.truncated;
    });

    function killGroup(signal: NodeJS.Signals): void {
      if (child.pid === undefined) {
        return;
      }

      try {
        process.kill(-child.pid, signal);
      } catch {
        // Process group may already be gone.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeoutMs);

    child.on('error', function handleError(error) {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', function handleClose(code, signal) {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export function truncateSummary(text: string): string {
  if (text.length <= MAX_VERIFICATION_SUMMARY_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_VERIFICATION_SUMMARY_CHARS)}\n\n[verification summary truncated]`;
}

export function formatVerificationResult(
  check: VerificationCheck,
  result: VerificationCommandResult,
  timeoutMs: number,
): string {
  const statusLine = formatCommandStatus(result, timeoutMs);
  const stdoutBlock = formatOutputBlock(
    'stdout',
    result.stdout,
    result.stdoutTruncated,
  );
  const stderrBlock = formatOutputBlock(
    'stderr',
    result.stderr,
    result.stderrTruncated,
  );

  return [`Check: ${check.description}`, statusLine, stdoutBlock, stderrBlock]
    .filter((part) => part.length > 0)
    .join('\n');
}
