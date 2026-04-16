import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  BudgetState,
  Feature,
  FeatureId,
  TaskId,
  TokenUsageAggregate,
  VerificationCheck,
  VerificationSummary,
} from '@core/types/index';
import type {
  OrchestratorPorts,
  VerificationPort,
} from '@orchestrator/ports/index';
import { addTokenUsageAggregates } from '@runtime/usage';

interface VerificationCommandResult {
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

function runShell(
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

function truncateSummary(text: string): string {
  if (text.length <= MAX_VERIFICATION_SUMMARY_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_VERIFICATION_SUMMARY_CHARS)}\n\n[verification summary truncated]`;
}

function formatVerificationResult(
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

export class RecoveryService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
    private readonly projectRoot = process.cwd(),
  ) {}

  async recoverOrphanedRuns(): Promise<void> {
    const runs = this.ports.store.listAgentRuns({
      scopeType: 'task',
    });

    for (const run of runs) {
      if (run.scopeType !== 'task') {
        continue;
      }

      if (
        run.runStatus === 'retry_await' ||
        run.runStatus === 'await_response' ||
        run.runStatus === 'await_approval'
      ) {
        continue;
      }

      if (run.runStatus !== 'running') {
        continue;
      }

      const task = this.graph.tasks.get(run.scopeId);
      if (task === undefined) {
        continue;
      }

      if (task.collabControl === 'suspended') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'ready',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        continue;
      }

      if (run.sessionId !== undefined) {
        await this.rebaseTaskWorktree(task);
        await this.ports.runtime.resumeTask(task.id, 'manual');
        this.ports.store.updateAgentRun(run.id, {
          restartCount: run.restartCount + 1,
        });
        continue;
      }

      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'ready',
        owner: 'system',
        restartCount: run.restartCount + 1,
      });
    }
  }

  private async rebaseTaskWorktree(task: {
    featureId: `f-${string}`;
    worktreeBranch?: string;
    id: string;
  }): Promise<void> {
    const feature = this.graph.features.get(task.featureId);
    if (feature === undefined) {
      return;
    }

    const branch =
      task.worktreeBranch ?? `feat-${task.featureId}-task-${task.id}`;
    const taskDir = path.resolve(this.projectRoot, worktreePath(branch));

    try {
      await fs.stat(taskDir);
    } catch {
      return;
    }

    const rebaseMarker = path.join(taskDir, 'RECOVERY_REBASE');
    await fs.writeFile(rebaseMarker, feature.featureBranch, 'utf-8');
  }
}

export class VerificationService implements VerificationPort {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly projectRoot = process.cwd(),
  ) {}

  async verifyFeature(feature: Feature): Promise<VerificationSummary> {
    const config = this.ports.config.verification?.feature;
    const checks = config?.checks ?? [];

    if (checks.length === 0) {
      return {
        ok: true,
        summary: 'No feature verification checks configured.',
      };
    }

    const cwd = await this.resolveFeatureWorktree(feature);
    const timeoutMs = Math.max(
      1,
      Math.round((config?.timeoutSecs ?? 60) * 1000),
    );
    const failedChecks: string[] = [];
    const failureDetails: string[] = [];

    for (const check of checks) {
      const result = await runShell(check.command, cwd, timeoutMs);
      if (result.timedOut || result.exitCode !== 0) {
        failedChecks.push(check.description);
        failureDetails.push(formatVerificationResult(check, result, timeoutMs));
        if (config?.continueOnFail !== true) {
          break;
        }
      }
    }

    if (failedChecks.length === 0) {
      return {
        ok: true,
        summary: `Feature verification passed (${checks.length}/${checks.length} checks).`,
      };
    }

    return {
      ok: false,
      summary: truncateSummary(
        `Feature verification failed (${failedChecks.length}/${checks.length} checks).\n\n${failureDetails.join('\n\n')}`,
      ),
      failedChecks,
    };
  }

  private async resolveFeatureWorktree(feature: Feature): Promise<string> {
    const candidate = path.resolve(
      this.projectRoot,
      worktreePath(feature.featureBranch),
    );

    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // handled below with explicit error
    }

    throw new Error(`feature worktree missing for ${feature.id}: ${candidate}`);
  }
}

export class BudgetService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
  ) {}

  async refresh(): Promise<BudgetState> {
    const taskRollups: Record<TaskId, TokenUsageAggregate | undefined> = {};
    const featurePhaseRollups: Record<
      FeatureId,
      TokenUsageAggregate | undefined
    > = {};
    const perTaskUsd: Record<string, number> = {};
    let totalUsd = 0;
    let totalCalls = 0;

    for (const run of this.ports.store.listAgentRuns()) {
      const usage = run.tokenUsage;
      if (usage === undefined) {
        continue;
      }

      totalUsd += usage.usd;
      totalCalls += usage.llmCalls;

      if (run.scopeType === 'task' && run.phase === 'execute') {
        const nextTaskUsage = addTokenUsageAggregates(
          taskRollups[run.scopeId],
          usage,
        );
        taskRollups[run.scopeId] = nextTaskUsage;
        perTaskUsd[run.scopeId] = nextTaskUsage.usd;
        continue;
      }

      if (run.scopeType === 'feature_phase') {
        featurePhaseRollups[run.scopeId] = addTokenUsageAggregates(
          featurePhaseRollups[run.scopeId],
          usage,
        );
      }
    }

    const featureRollups: Record<FeatureId, TokenUsageAggregate | undefined> =
      {};
    for (const feature of this.graph.features.values()) {
      const taskUsage = addTokenUsageAggregates(
        ...[...this.graph.tasks.values()]
          .filter((task) => task.featureId === feature.id)
          .map((task) => taskRollups[task.id]),
      );
      const featureUsage = addTokenUsageAggregates(
        taskUsage,
        featurePhaseRollups[feature.id],
      );
      if (featureUsage.llmCalls > 0 || featureUsage.totalTokens > 0) {
        featureRollups[feature.id] = featureUsage;
      }
    }

    this.graph.replaceUsageRollups({
      tasks: taskRollups,
      features: featureRollups,
    });

    return {
      totalUsd,
      totalCalls,
      perTaskUsd,
    };
  }
}
