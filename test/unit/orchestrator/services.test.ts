import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { worktreePath } from '@core/naming/index';
import type { Feature, GvcConfig, VerificationCheck } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { VerificationService } from '@orchestrator/services/index';
import { describe, expect, it } from 'vitest';

import { useTmpDir } from '../../helpers/tmp-dir.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createPorts(
  configOverrides: Partial<GvcConfig> = {},
): OrchestratorPorts {
  return {
    config: createConfig(configOverrides),
  } as OrchestratorPorts;
}

function createFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f-1',
    milestoneId: 'm-1',
    orderInMilestone: 0,
    name: 'Feature 1',
    description: 'desc',
    dependsOn: [],
    status: 'pending',
    workControl: 'feature_ci',
    collabControl: 'branch_open',
    featureBranch: 'feat-feature-1-1',
    ...overrides,
  };
}

function createFeatureVerificationConfig(
  checks: VerificationCheck[],
  overrides: {
    timeoutSecs?: number;
    continueOnFail?: boolean;
  } = {},
): GvcConfig {
  return createConfig({
    verification: {
      feature: {
        checks,
        timeoutSecs: overrides.timeoutSecs ?? 1,
        continueOnFail: overrides.continueOnFail ?? false,
      },
    },
  });
}

async function createFeatureWorktree(
  root: string,
  feature: Feature,
): Promise<string> {
  const dir = path.join(root, worktreePath(feature.featureBranch));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('VerificationService', () => {
  const getTmpDir = useTmpDir('orchestrator-services');

  it('passes when no feature checks are configured', async () => {
    const service = new VerificationService(createPorts(), getTmpDir());

    await expect(service.verifyFeature(createFeature())).resolves.toEqual({
      ok: true,
      summary: 'No feature verification checks configured.',
    });
  });

  it('runs configured checks in feature worktree when present', async () => {
    const root = getTmpDir();
    const feature = createFeature();
    const worktree = await createFeatureWorktree(root, feature);
    await fs.writeFile(path.join(worktree, 'marker.txt'), 'here');

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig([
          { description: 'list marker', command: 'ls marker.txt' },
        ]),
      ),
      root,
    );

    await expect(service.verifyFeature(feature)).resolves.toEqual({
      ok: true,
      summary: 'Feature verification passed (1/1 checks).',
    });
  });

  it('throws when feature worktree is missing', async () => {
    const root = getTmpDir();

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig([
          { description: 'list root marker', command: 'ls root-marker.txt' },
        ]),
      ),
      root,
    );

    await expect(service.verifyFeature(createFeature())).rejects.toThrow(
      'feature worktree missing for f-1',
    );
  });

  it('returns deterministic failure details for failed checks', async () => {
    const root = getTmpDir();
    const feature = createFeature();
    await createFeatureWorktree(root, feature);

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig([
          {
            description: 'stderr check',
            command: 'echo bad 1>&2; exit 3',
          },
        ]),
      ),
      root,
    );

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['stderr check']);
    expect(result.summary).toContain('stderr check');
    expect(result.summary).toContain('[exit 3');
    expect(result.summary).toContain('bad');
  });

  it('stops after first failure when continueOnFail is false', async () => {
    const root = getTmpDir();
    const feature = createFeature();
    const worktree = await createFeatureWorktree(root, feature);

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig(
          [
            { description: 'first failure', command: 'exit 1' },
            { description: 'second check', command: 'touch second-ran.txt' },
          ],
          { continueOnFail: false },
        ),
      ),
      root,
    );

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['first failure']);
    await expect(
      fs.stat(path.join(worktree, 'second-ran.txt')),
    ).rejects.toThrow();
  });

  it('continues after failure when continueOnFail is true', async () => {
    const root = getTmpDir();
    const feature = createFeature();
    const worktree = await createFeatureWorktree(root, feature);

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig(
          [
            { description: 'first failure', command: 'exit 1' },
            { description: 'second check', command: 'touch second-ran.txt' },
          ],
          { continueOnFail: true },
        ),
      ),
      root,
    );

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['first failure']);
    await expect(
      fs.stat(path.join(worktree, 'second-ran.txt')),
    ).resolves.toBeTruthy();
  });

  it('marks timed out checks as failed', async () => {
    const root = getTmpDir();
    const feature = createFeature();
    await createFeatureWorktree(root, feature);

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig(
          [{ description: 'slow check', command: 'sleep 1' }],
          { timeoutSecs: 0.05 },
        ),
      ),
      root,
    );

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['slow check']);
    expect(result.summary).toContain('timed out');
  });

  it('truncates oversized aggregated failure summaries', async () => {
    const root = getTmpDir();
    const feature = createFeature();
    await createFeatureWorktree(root, feature);

    const service = new VerificationService(
      createPorts(
        createFeatureVerificationConfig(
          [
            {
              description: 'first failure',
              command:
                'node -e "process.stderr.write(\'x\'.repeat(20000)); process.exit(1)"',
            },
            {
              description: 'second failure',
              command:
                'node -e "process.stderr.write(\'x\'.repeat(20000)); process.exit(1)"',
            },
          ],
          { continueOnFail: true, timeoutSecs: 5 },
        ),
      ),
      root,
    );

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['first failure', 'second failure']);
    expect(result.summary?.length ?? 0).toBeLessThanOrEqual(16_512);
    expect(result.summary).toContain('[verification summary truncated]');
    expect(result.summary).toContain('[stderr truncated]');
  });
});
