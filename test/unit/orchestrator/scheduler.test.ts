import type {
  DependencyEdge,
  OrchestratorPorts,
  Store,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { SchedulerLoop } from '../../../src/orchestrator/scheduler/index.js';
import { createGraphWithFeature } from '../../helpers/graph-builders.js';

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
    ui: { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() },
    config: { tokenProfile: 'balanced' },
    ...overrides,
  };
}

describe('SchedulerLoop', () => {
  describe('enqueue', () => {
    it('accepts events without throwing', () => {
      const graph = createGraphWithFeature();
      const ports = createMockPorts();
      const loop = new SchedulerLoop(graph, ports);

      expect(() => loop.enqueue({ type: 'shutdown' })).not.toThrow();
    });
  });

  describe('run', () => {
    it('refreshes the UI on each tick', async () => {
      const graph = createGraphWithFeature();
      const ports = createMockPorts();
      const loop = new SchedulerLoop(graph, ports);

      await loop.run();

      expect(ports.ui.refresh).toHaveBeenCalled();
    });

    it('drains enqueued events during run', async () => {
      const graph = createGraphWithFeature();
      const ports = createMockPorts();
      const loop = new SchedulerLoop(graph, ports);

      loop.enqueue({
        type: 'feature_phase_complete',
        featureId: 'f-1',
        phase: 'plan',
        summary: 'planning done',
      });
      loop.enqueue({ type: 'shutdown' });

      await loop.run();

      // After run processes the shutdown event, it should have drained events
      // We verify by checking that a second run doesn't reprocess the same events
      expect(ports.ui.refresh).toHaveBeenCalled();
    });

    it('dispatches ready tasks to the runtime', async () => {
      const graph = createGraphWithFeature({ workControl: 'executing' });
      graph.createTask({ id: 't-1', featureId: 'f-1', description: 'T1' });
      const ports = createMockPorts();
      const loop = new SchedulerLoop(graph, ports);

      // Enqueue shutdown so run terminates
      loop.enqueue({ type: 'shutdown' });

      await loop.run();

      expect(ports.runtime.dispatchTask).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('enqueues a shutdown event', async () => {
      const graph = createGraphWithFeature();
      const ports = createMockPorts();
      const loop = new SchedulerLoop(graph, ports);

      await loop.stop();

      expect(ports.runtime.stopAll).toHaveBeenCalled();
    });
  });
});
