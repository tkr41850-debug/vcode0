import type {
  DependencyEdge,
  OrchestratorPorts,
  Store,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { GvcApplication } from '../../../src/app/index.js';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function createMockStore(overrides: Partial<Store> = {}): Store {
  return {
    loadRecoveryState: vi.fn(
      async (): Promise<StoreRecoveryState> => ({
        milestones: [createMilestoneFixture({ id: 'm-1', name: 'MVP' })],
        features: [
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            name: 'Auth',
          }),
        ],
        tasks: [
          createTaskFixture({
            id: 't-1',
            featureId: 'f-1',
            description: 'Login',
          }),
        ],
        agentRuns: [
          {
            id: 'run-orphan',
            scopeType: 'task',
            scopeId: 't-1',
            phase: 'execute',
            runStatus: 'running',
            owner: 'system',
            attention: 'none',
            restartCount: 0,
            maxRetries: 3,
          },
        ],
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

function createMockPorts(store: Store): OrchestratorPorts {
  return {
    store,
    git: {} as OrchestratorPorts['git'],
    runtime: {
      dispatchTask: vi.fn(),
      steerTask: vi.fn(),
      suspendTask: vi.fn(),
      resumeTask: vi.fn(),
      abortTask: vi.fn(),
      idleWorkerCount: vi.fn(() => 4),
      stopAll: vi.fn(async () => {}),
    },
    agents: {} as OrchestratorPorts['agents'],
    ui: {
      show: vi.fn(async () => {}),
      refresh: vi.fn(),
      dispose: vi.fn(),
    },
    config: { tokenProfile: 'balanced' },
  };
}

describe('GvcApplication lifecycle (integration)', () => {
  it('recovers orphaned runs and shows UI on start', async () => {
    const store = createMockStore();
    const ports = createMockPorts(store);
    const app = new GvcApplication(ports);

    await app.start();

    // Recovery should have loaded state
    expect(store.loadRecoveryState).toHaveBeenCalled();
    // Orphaned running run should be marked failed
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-orphan', {
      runStatus: 'failed',
    });
    // UI should be shown
    expect(ports.ui.show).toHaveBeenCalled();
  });

  it('stops runtime and disposes UI on stop', async () => {
    const store = createMockStore();
    const ports = createMockPorts(store);
    const app = new GvcApplication(ports);

    await app.start();
    await app.stop();

    expect(ports.runtime.stopAll).toHaveBeenCalled();
    expect(ports.ui.dispose).toHaveBeenCalled();
  });

  it('full start-stop cycle does not throw', async () => {
    const store = createMockStore();
    const ports = createMockPorts(store);
    const app = new GvcApplication(ports);

    await app.start('auto');
    await app.stop();

    // Verify the full lifecycle completed
    expect(store.loadRecoveryState).toHaveBeenCalledTimes(1);
    expect(ports.runtime.stopAll).toHaveBeenCalledTimes(1);
  });
});
