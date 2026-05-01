import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { AgentRun, FeatureId } from '@core/types/index';

/**
 * Synthesized error frames carry no real stack — they are produced by the
 * orchestrator side when a worker dies without sending an `error` IPC frame.
 * Naming the synthesizer in the log header lets an operator reading
 * `.gvc0/logs/*.txt` distinguish "the agent threw" from "the child exited".
 */
export type SynthesizedErrorReason = 'worker_exited' | 'health_timeout';

export interface RunErrorLogInput {
  run: AgentRun;
  featureId: FeatureId | undefined;
  taskId: string | undefined;
  error: { message: string; stack?: string };
  synthesizedReason?: SynthesizedErrorReason;
  nowMs: number;
}

/**
 * Port for writing one human-readable text artifact per first failure of a
 * run. Implementations are debug-only — sink failure must NEVER propagate
 * back to the scheduler tick. The "first failure" gate (restartCount === 0)
 * lives inside the implementation, not at the call site, so retry-policy
 * changes can never bypass it.
 */
export interface RunErrorLogSink {
  writeFirstFailure(input: RunErrorLogInput): Promise<void>;
}

const SLUG_MAX = 32;
const NO_STACK_SENTINEL =
  '(no stack: this error was synthesized by the orchestrator from a child-process exit; no IPC error frame was received)';

/** Strip path separators and whitespace. Stable for the same input. */
function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > SLUG_MAX ? cleaned.slice(0, SLUG_MAX) : cleaned;
}

function isoForFilename(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function buildSlug(input: RunErrorLogInput): string {
  const ts = isoForFilename(input.nowMs);
  const scopeKind = scopeKindLabel(input.run);
  const featurePart = slug(input.featureId ?? 'no-feature');
  const phase = slug(input.run.phase);
  const taskPart = input.taskId !== undefined ? `-${slug(input.taskId)}` : '';
  const attempt = `a${input.run.restartCount}`;
  const runShort = slug(shortRunId(input.run.id));
  return `${ts}-${scopeKind}-${featurePart}-${phase}${taskPart}-${attempt}-${runShort}.txt`;
}

function scopeKindLabel(run: AgentRun): 'task' | 'feature' | 'project' {
  switch (run.scopeType) {
    case 'task':
      return 'task';
    case 'feature_phase':
      return 'feature';
    case 'project':
      return 'project';
    default: {
      const exhaustive: never = run;
      throw new Error(
        `unexpected agent run scopeType: ${(exhaustive as AgentRun).scopeType}`,
      );
    }
  }
}

function renderBody(input: RunErrorLogInput): string {
  const { run, featureId, taskId, error, synthesizedReason, nowMs } = input;
  const ts = new Date(nowMs).toISOString();
  const lines: string[] = [
    'gvc0 first-failure log',
    `runId: ${run.id}`,
    `scopeType: ${run.scopeType}`,
    `scopeId: ${run.scopeId}`,
    `featureId: ${featureId ?? '->'}`,
    `phase: ${run.phase}`,
    `taskId: ${taskId ?? '->'}`,
    `sessionId: ${run.sessionId ?? '->'}`,
    `restartCount: ${run.restartCount}`,
    `maxRetries: ${run.maxRetries}`,
    `retryAt: ${run.retryAt ?? '->'}`,
    `ts: ${ts}`,
    `synthesizedReason: ${synthesizedReason ?? '->'}`,
    '',
    '--- message ---',
    error.message,
    '',
    '--- stack ---',
    error.stack ?? NO_STACK_SENTINEL,
    '',
  ];
  return lines.join('\n');
}

export interface FileSystemRunErrorLogSinkConfig {
  projectRoot: string;
  /** Subdirectory under `<projectRoot>/.gvc0/`. Defaults to `'logs'`. */
  logDirName?: string;
}

/**
 * Filesystem-backed sink. Writes one `.txt` per first failure under
 * `<projectRoot>/.gvc0/<logDirName>/`. Uses `wx` write mode so a slug
 * collision is loud rather than silently overwriting; the timestamp +
 * runId-suffix combination should make collisions effectively impossible.
 *
 * Errors during write are swallowed and surfaced as a single stderr line —
 * a missing log directory or a read-only filesystem must not crash the
 * scheduler tick. The sink is debug-only; the actual `retry_await` state
 * transition lives elsewhere and is the source of truth.
 */
export class FileSystemRunErrorLogSink implements RunErrorLogSink {
  private readonly projectRoot: string;
  private readonly logDirName: string;

  constructor(config: FileSystemRunErrorLogSinkConfig) {
    this.projectRoot = config.projectRoot;
    this.logDirName = config.logDirName ?? 'logs';
  }

  async writeFirstFailure(input: RunErrorLogInput): Promise<void> {
    if (input.run.restartCount !== 0) {
      console.error(
        `[run-error-log] skip: runId=${input.run.id} restartCount=${input.run.restartCount} (first-failure gate)`,
      );
      return;
    }

    const dir = path.join(this.projectRoot, '.gvc0', this.logDirName);
    const filename = buildSlug(input);
    const filePath = path.join(dir, filename);
    const body = renderBody(input);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, body, { encoding: 'utf8', flag: 'wx' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[run-error-log] write failed: runId=${input.run.id} path=${filePath} error=${message}`,
      );
    }
  }
}
