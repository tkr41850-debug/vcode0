import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
} from '@core/types/index';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import { createGraphWithFeature } from '../../helpers/graph-builders.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';
import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '../../integration/harness/faux-stream.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';
import { InMemoryStore } from '../../integration/harness/store-memory.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced',
    ...overrides,
  };
}

const getTmpDir = useTmpDir('verify-contract');

function createFeatureRun(): FeaturePhaseAgentRun {
  return {
    id: 'run-feature:f-1:verify',
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase: 'verify',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
  };
}

async function initFeatureWorktreeRepo(
  projectRoot: string,
  feature: Feature,
  changes: Array<{ filePath: string; content: string }> = [],
): Promise<void> {
  const worktreeDir = path.join(
    projectRoot,
    worktreePath(feature.featureBranch),
  );
  await fs.mkdir(worktreeDir, { recursive: true });

  const git = simpleGit(worktreeDir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test Runner', false, 'local');

  await fs.writeFile(path.join(worktreeDir, 'seed.txt'), 'seed\n');
  await git.add(['seed.txt']);
  await git.commit('seed');
  await git.branch(['-M', 'main']);
  await git.checkoutLocalBranch(feature.featureBranch);

  for (const change of changes) {
    const filePath = path.join(worktreeDir, change.filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, change.content);
  }

  if (changes.length > 0) {
    await git.add(['.']);
    await git.commit('feature changes');
  }
}

function createVerifyFixture(projectRoot: string): {
  feature: Feature;
  run: FeaturePhaseAgentRun;
  store: InMemoryStore;
  runtime: PiFeatureAgentRuntime;
} {
  const graph = createGraphWithFeature({
    name: 'Feature 1',
    description: 'Implement feature 1',
    workControl: 'verifying',
    collabControl: 'branch_open',
  });
  const feature = graph.features.get('f-1');
  if (feature === undefined) {
    throw new Error('feature f-1 not found');
  }
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const run = createFeatureRun();
  store.createAgentRun(run);

  const runtime = new PiFeatureAgentRuntime({
    modelId: 'claude-sonnet-4-6',
    config: createConfig(),
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot,
  });

  return { feature, run, store, runtime };
}

describe('verify submit contract', () => {
  let faux: FauxProviderRegistration;

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-6' }],
    });
  });

  afterEach(() => {
    faux.unregister();
  });

  it('records a pass outcome from submitVerify', async () => {
    const projectRoot = getTmpDir();
    const { feature, run, store, runtime } = createVerifyFixture(projectRoot);
    await initFeatureWorktreeRepo(projectRoot, feature, [
      {
        filePath: 'src/feature.ts',
        content: 'export const feature = true;\n',
      },
    ]);

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('submitVerify', {
            outcome: 'pass',
            summary: 'Verified cleanly.',
            criteriaEvidence: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),
    ]);

    const result = await runtime.verifyFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: 'pass',
      summary: 'Verified cleanly.',
    });
    expect(result.issues).toBeUndefined();
    expect(
      JSON.parse(store.getAgentRun(run.id)?.payloadJson ?? '{}'),
    ).toMatchObject({
      ok: true,
      outcome: 'pass',
      summary: 'Verified cleanly.',
    });
  }, 15_000);

  it('records repair_needed with raised blocking issues', async () => {
    const projectRoot = getTmpDir();
    const { feature, run, store, runtime } = createVerifyFixture(projectRoot);
    await initFeatureWorktreeRepo(projectRoot, feature, [
      { filePath: 'src/auth.ts', content: 'export const auth = false;\n' },
    ]);

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('raiseIssue', {
            severity: 'blocking',
            description: 'auth gap',
            location: 'src/auth.ts',
          }),
          fauxToolCall('submitVerify', {
            outcome: 'repair_needed',
            summary: 'Repair needed for auth gap.',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),
    ]);

    const result = await runtime.verifyFeature(feature, { agentRunId: run.id });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('repair_needed');
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]).toMatchObject({
      severity: 'blocking',
      description: 'auth gap',
      location: 'src/auth.ts',
    });
    expect(
      JSON.parse(store.getAgentRun(run.id)?.payloadJson ?? '{}'),
    ).toMatchObject({
      outcome: 'repair_needed',
      issues: [expect.objectContaining({ description: 'auth gap' })],
    });
  });

  it('throws when verify finishes without submitVerify', async () => {
    const projectRoot = getTmpDir();
    const { feature, run, runtime } = createVerifyFixture(projectRoot);
    await initFeatureWorktreeRepo(projectRoot, feature);

    faux.setResponses([
      fauxAssistantMessage([fauxText('I have nothing to say')]),
    ]);

    await expect(
      runtime.verifyFeature(feature, { agentRunId: run.id }),
    ).rejects.toThrow(/submitVerify/i);
  });

  it('auto-downgrades pass to repair_needed when blocking issues exist', async () => {
    const projectRoot = getTmpDir();
    const { feature, run, runtime } = createVerifyFixture(projectRoot);
    await initFeatureWorktreeRepo(projectRoot, feature, [
      { filePath: 'src/feature.ts', content: 'export const feature = true;\n' },
    ]);

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('raiseIssue', {
            severity: 'blocking',
            description: 'missing proof',
          }),
          fauxToolCall('submitVerify', {
            outcome: 'pass',
            summary: 'Attempted pass.',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),
    ]);

    const result = await runtime.verifyFeature(feature, { agentRunId: run.id });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('repair_needed');
    expect(result.failedChecks).toEqual(['missing proof']);
  });
});
