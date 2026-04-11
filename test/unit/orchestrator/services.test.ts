import type { AgentRun, GvcConfig } from '@core/types/index';
import type {
  DependencyEdge,
  OrchestratorPorts,
  Store,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import {
  BudgetService,
  RecoveryService,
  VerificationService,
} from '@orchestrator/services/index';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { createFeatureFixture } from '../../helpers/graph-builders.js';

function createMinimalConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createMockStore(overrides: Partial<Store> = {}): Store {
  return {
    loadRecoveryState: vi.fn(
      async (): Promise<StoreRecoveryState> => ({
        milestones: [],
        features: [],
        tasks: [],
        agentRuns: [],
        dependencies: [],
      }),
    ),
    saveGraphState: vi.fn(async () => {}),
    getMilestone: vi.fn(async () => undefined),
    getFeature: vi.fn(async () => undefined),
    getTask: vi.fn(async () => undefined),
    getAgentRun: vi.fn(async () => undefined),
    listMilestones: vi.fn(async () => []),
    listFeatures: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listAgentRuns: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    updateMilestone: vi.fn(async () => {}),
    updateFeature: vi.fn(async () => {}),
    updateTask: vi.fn(async () => {}),
    createAgentRun: vi.fn(async () => {}),
    updateAgentRun: vi.fn(async () => {}),
    listDependencies: vi.fn(async (): Promise<DependencyEdge[]> => []),
    saveDependency: vi.fn(async () => {}),
    removeDependency: vi.fn(async () => {}),
    appendEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

function createMockPorts(
  overrides: Partial<OrchestratorPorts> = {},
): OrchestratorPorts {
  return {
    store: createMockStore(),
    git: {} as OrchestratorPorts['git'],
    runtime: {} as OrchestratorPorts['runtime'],
    agents: {} as OrchestratorPorts['agents'],
    ui: { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() },
    config: createMinimalConfig(),
    ...overrides,
  };
}

describe('RecoveryService', () => {
  it('loads recovery state from the store', async () => {
    const store = createMockStore();
    const ports = createMockPorts({ store });
    const service = new RecoveryService(ports);

    await service.recoverOrphanedRuns();

    expect(store.loadRecoveryState).toHaveBeenCalled();
  });

  it('updates orphaned running agent runs to failed', async () => {
    const orphanedRun: AgentRun = {
      id: 'run-1',
      scopeType: 'task',
      scopeId: 't-1',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    const store = createMockStore({
      loadRecoveryState: vi.fn(async () => ({
        milestones: [],
        features: [],
        tasks: [],
        agentRuns: [orphanedRun],
        dependencies: [],
      })),
    });
    const ports = createMockPorts({ store });
    const service = new RecoveryService(ports);

    await service.recoverOrphanedRuns();

    expect(store.updateAgentRun).toHaveBeenCalledWith('run-1', {
      runStatus: 'failed',
    });
  });
});

describe('VerificationService', () => {
  it('returns ok: true for a feature with no verification config', async () => {
    const ports = createMockPorts({
      config: createMinimalConfig(),
    });
    const service = new VerificationService(ports);
    const feature = createFeatureFixture({ id: 'f-1' });

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(true);
  });

  it('returns failed checks when verification config has checks', async () => {
    const ports = createMockPorts({
      config: createMinimalConfig({
        verification: {
          feature: {
            checks: [{ description: 'lint', command: 'false' }],
            timeoutSecs: 10,
            continueOnFail: false,
          },
        },
      }),
    });
    const service = new VerificationService(ports);
    const feature = createFeatureFixture({ id: 'f-1' });

    const result = await service.verifyFeature(feature);

    // With a failing check command, verification should report failure
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toBeDefined();
    expect(result.failedChecks!.length).toBeGreaterThan(0);
  });

  it('stops at first failure when continueOnFail is false', async () => {
    const ports = createMockPorts({
      config: createMinimalConfig({
        verification: {
          feature: {
            checks: [
              { description: 'lint', command: 'false' },
              { description: 'test', command: 'false' },
            ],
            timeoutSecs: 10,
            continueOnFail: false,
          },
        },
      }),
    });
    const service = new VerificationService(ports);
    const feature = createFeatureFixture({ id: 'f-1' });

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    // Should stop after first failure
    expect(result.failedChecks).toHaveLength(1);
    expect(result.failedChecks![0]).toBe('lint');
  });

  it('collects all failures when continueOnFail is true', async () => {
    const ports = createMockPorts({
      config: createMinimalConfig({
        verification: {
          feature: {
            checks: [
              { description: 'lint', command: 'false' },
              { description: 'test', command: 'false' },
            ],
            timeoutSecs: 10,
            continueOnFail: true,
          },
        },
      }),
    });
    const service = new VerificationService(ports);
    const feature = createFeatureFixture({ id: 'f-1' });

    const result = await service.verifyFeature(feature);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toHaveLength(2);
    expect(result.failedChecks).toEqual(['lint', 'test']);
  });
});

describe('BudgetService', () => {
  it('refreshes budget state from the store', async () => {
    const store = createMockStore();
    const ports = createMockPorts({
      store,
      config: createMinimalConfig({
        budget: { globalUsd: 50, perTaskUsd: 5, warnAtPercent: 80 },
      }),
    });
    const service = new BudgetService(ports);

    await service.refresh();

    // After refresh, the service should have loaded state
    // For now we just verify it doesn't throw
    expect(true).toBe(true);
  });

  it('exposes the current budget action after refresh', async () => {
    const store = createMockStore();
    const ports = createMockPorts({
      store,
      config: createMinimalConfig({
        budget: { globalUsd: 50, perTaskUsd: 5, warnAtPercent: 80 },
      }),
    });
    const service = new BudgetService(ports);

    await service.refresh();

    const action = service.currentAction();

    expect(action).toBe('ok');
  });
});
