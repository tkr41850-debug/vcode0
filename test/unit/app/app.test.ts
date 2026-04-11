import type {
  DependencyEdge,
  OrchestratorPorts,
  Store,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import { describe, expect, it, vi } from 'vitest';

import { GvcApplication } from '../../../src/app/index.js';

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
    ...overrides,
  };
}

describe('GvcApplication', () => {
  it('shows the UI on start', async () => {
    const ports = createMockPorts();
    const app = new GvcApplication(ports);

    await app.start();

    expect(ports.ui.show).toHaveBeenCalled();
  });

  it('disposes the UI on stop', async () => {
    const ports = createMockPorts();
    const app = new GvcApplication(ports);

    await app.stop();

    expect(ports.ui.dispose).toHaveBeenCalled();
  });

  it('runs recovery on start', async () => {
    const store = createMockStore();
    const ports = createMockPorts({ store });
    const app = new GvcApplication(ports);

    await app.start();

    expect(store.loadRecoveryState).toHaveBeenCalled();
  });

  it('stops the runtime on stop', async () => {
    const ports = createMockPorts();
    const app = new GvcApplication(ports);

    await app.stop();

    expect(ports.runtime.stopAll).toHaveBeenCalled();
  });
});
