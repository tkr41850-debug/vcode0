import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  TaskAgentRun,
  TokenUsageAggregate,
  VerificationCheck,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { BudgetService, VerificationService } from '@orchestrator/services/index';
import { describe, expect, it } from 'vitest';

import { createInMemoryStore } from '../../integration/harness/store-memory.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';

function usageAggregate(usd: number, llmCalls = 1): TokenUsageAggregate {
  const inputTokens = 10 * llmCalls;
  const outputTokens = 5 * llmCalls;
  const totalTokens = inputTokens + outputTokens;

  return {
    llmCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens,
    usd,
    byModel: {
      'anthropic:claude-sonnet-4-6': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        llmCalls,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        totalTokens,
        usd,
      },
    },
  };
}

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

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-task-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'completed',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeFeaturePhaseRun(
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: 'run-feature:f-1:discuss',
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase: 'discuss',
    runStatus: 'completed',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe('BudgetService', () => {
  it('recomputes task, feature, and global usage from persisted agent runs', async () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [
        {
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'F1',
          description: 'd',
          dependsOn: [],
          status: 'pending',
          workControl: 'executing',
          collabControl: 'branch_open',
          featureBranch: 'feat-f-1',
          tokenUsage: usageAggregate(999),
        },
        {
          id: 'f-2',
          milestoneId: 'm-1',
          orderInMilestone: 1,
          name: 'F2',
          description: 'd',
          dependsOn: [],
          status: 'pending',
          workControl: 'researching',
          collabControl: 'branch_open',
          featureBranch: 'feat-f-2',
          tokenUsage: usageAggregate(888),
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'T1',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
          tokenUsage: usageAggregate(777),
        },
        {
          id: 't-2',
          featureId: 'f-1',
          orderInFeature: 1,
          description: 'T2',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
        {
          id: 't-3',
          featureId: 'f-2',
          orderInFeature: 0,
          description: 'T3',
          dependsOn: [],
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    const store = createInMemoryStore();
    store.createAgentRun(
      makeTaskRun({
        id: 'run-task-1',
        scopeId: 't-1',
        tokenUsage: usageAggregate(1.25),
      }),
    );
    store.createAgentRun(
      makeTaskRun({
        id: 'run-task-1-retry',
        scopeId: 't-1',
        runStatus: 'failed',
        tokenUsage: usageAggregate(0.75, 2),
      }),
    );
    store.createAgentRun(
      makeTaskRun({
        id: 'run-task-2',
        scopeId: 't-2',
        tokenUsage: usageAggregate(2.5, 3),
      }),
    );
    store.createAgentRun(
      makeTaskRun({
        id: 'run-task-3',
        scopeId: 't-3',
      }),
    );
    store.createAgentRun(
      makeFeaturePhaseRun({
        id: 'run-feature:f-1:discuss',
        scopeId: 'f-1',
        phase: 'discuss',
        tokenUsage: usageAggregate(0.6),
      }),
    );
    store.createAgentRun(
      makeFeaturePhaseRun({
        id: 'run-feature:f-1:verify',
        scopeId: 'f-1',
        phase: 'verify',
        runStatus: 'failed',
        tokenUsage: usageAggregate(0.4, 2),
      }),
    );
    store.createAgentRun(
      makeFeaturePhaseRun({
        id: 'run-feature:f-2:research',
        scopeId: 'f-2',
        phase: 'research',
        tokenUsage: usageAggregate(0.9),
      }),
    );

    const service = new BudgetService(
      {
        store,
      } as OrchestratorPorts,
      graph,
    );

    const state = await service.refresh();

    expect(graph.tasks.get('t-1')?.tokenUsage).toEqual(usageAggregate(2, 3));
    expect(graph.tasks.get('t-2')?.tokenUsage).toEqual(usageAggregate(2.5, 3));
    expect(graph.tasks.get('t-3')?.tokenUsage).toBeUndefined();
    expect(graph.features.get('f-1')?.tokenUsage).toEqual(usageAggregate(5.5, 9));
    expect(graph.features.get('f-2')?.tokenUsage).toEqual(usageAggregate(0.9));
    expect(state).toEqual({
      totalUsd: 6.4,
      totalCalls: 10,
      perTaskUsd: {
        't-1': 2,
        't-2': 2.5,
      },
    });
  });

  it('clears stale graph rollups when no persisted usage exists', async () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'M1',
          description: 'd',
          status: 'pending',
          order: 0,
        },
      ],
      features: [
        {
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'F1',
          description: 'd',
          dependsOn: [],
          status: 'pending',
          workControl: 'executing',
          collabControl: 'branch_open',
          featureBranch: 'feat-f-1',
          tokenUsage: usageAggregate(4),
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'T1',
          dependsOn: [],
          status: 'running',
          collabControl: 'branch_open',
          tokenUsage: usageAggregate(2),
        },
      ],
    });
    const store = createInMemoryStore();
    const service = new BudgetService(
      {
        store,
      } as OrchestratorPorts,
      graph,
    );

    const state = await service.refresh();

    expect(graph.features.get('f-1')?.tokenUsage).toBeUndefined();
    expect(graph.tasks.get('t-1')?.tokenUsage).toBeUndefined();
    expect(state).toEqual({
      totalUsd: 0,
      totalCalls: 0,
      perTaskUsd: {},
    });
  });
});

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
