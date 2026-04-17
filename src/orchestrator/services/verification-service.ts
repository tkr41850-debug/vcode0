import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  VerificationLayerConfig,
  VerificationSummary,
} from '@core/types/index';
import type {
  OrchestratorPorts,
  VerificationPort,
} from '@orchestrator/ports/index';
import { resolveVerificationLayerConfig } from '@root/config';

import {
  formatVerificationResult,
  runShell,
  truncateSummary,
} from './verification-shell.js';

export class VerificationService implements VerificationPort {
  constructor(
    private readonly ports: Pick<OrchestratorPorts, 'config'>,
    private readonly projectRoot = process.cwd(),
  ) {}

  async verifyFeature(feature: Feature): Promise<VerificationSummary> {
    const config = resolveVerificationLayerConfig(this.ports.config, 'feature');
    const cwd = await this.resolveFeatureWorktree(feature);
    return this.runLayerChecks(
      'Feature verification',
      'No feature verification checks configured.',
      config,
      cwd,
    );
  }

  private async runLayerChecks(
    label: string,
    emptySummary: string,
    config: VerificationLayerConfig,
    cwd: string,
  ): Promise<VerificationSummary> {
    const checks = config.checks;

    if (checks.length === 0) {
      return {
        ok: true,
        summary: emptySummary,
      };
    }

    const timeoutMs = Math.max(1, Math.round(config.timeoutSecs * 1000));
    const failedChecks: string[] = [];
    const failureDetails: string[] = [];

    for (const check of checks) {
      const result = await runShell(check.command, cwd, timeoutMs);
      if (result.timedOut || result.exitCode !== 0) {
        failedChecks.push(check.description);
        failureDetails.push(formatVerificationResult(check, result, timeoutMs));
        if (config.continueOnFail !== true) {
          break;
        }
      }
    }

    if (failedChecks.length === 0) {
      return {
        ok: true,
        summary: `${label} passed (${checks.length}/${checks.length} checks).`,
      };
    }

    return {
      ok: false,
      summary: truncateSummary(
        `${label} failed (${failedChecks.length}/${checks.length} checks).\n\n${failureDetails.join('\n\n')}`,
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
