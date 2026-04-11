import type {
  DependencyEdge,
  OrchestratorPorts,
  Store,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { SummaryCoordinator } from '../../../src/orchestrator/summaries/index.js';
import { createFeatureFixture } from '../../helpers/graph-builders.js';

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
    config: { tokenProfile: 'balanced' },
    ...overrides,
  };
}

describe('SummaryCoordinator', () => {
  describe('summarize', () => {
    it('stores a summary string on the feature', async () => {
      const store = createMockStore();
      const ports = createMockPorts({ store });
      const coordinator = new SummaryCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-1', name: 'Auth flow' });

      await coordinator.summarize(feature);

      expect(store.updateFeature).toHaveBeenCalledWith(
        'f-1',
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          summary: expect.any(String),
        }),
      );
    });

    it('appends a summarize event', async () => {
      const store = createMockStore();
      const ports = createMockPorts({ store });
      const coordinator = new SummaryCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-1' });

      await coordinator.summarize(feature);

      expect(store.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'feature_summarized',
          entityId: 'f-1',
        }),
      );
    });
  });

  describe('skip', () => {
    it('appends a summary_skipped event', async () => {
      const store = createMockStore();
      const ports = createMockPorts({ store });
      const coordinator = new SummaryCoordinator(ports);
      const feature = createFeatureFixture({ id: 'f-2' });

      await coordinator.skip(feature);

      expect(store.appendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'summary_skipped',
          entityId: 'f-2',
        }),
      );
    });
  });
});
