import { InMemoryFeatureGraph } from '@core/graph/index';
import type { Feature, Task } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  dispatchReadyWork,
  hasUnmergedFeatureDep,
} from '@orchestrator/scheduler/dispatch';
import { describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function buildGraph(
  features: Feature[],
  tasks: Task[] = [],
): InMemoryFeatureGraph {
  const g = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features,
    tasks,
  });
  g.__enterTick();
  return g;
}

describe('hasUnmergedFeatureDep', () => {
  it('returns unmerged when any dep is not work_complete+merged', () => {
    const graph = buildGraph([
      createFeatureFixture({
        id: 'f-a',
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
      createFeatureFixture({
        id: 'f-b',
        workControl: 'executing',
        collabControl: 'branch_open',
        dependsOn: ['f-a'],
      }),
    ]);
    const result = hasUnmergedFeatureDep(graph, 'f-b');
    expect(result).toEqual({ unmerged: true, depId: 'f-a' });
  });

  it('returns not unmerged when all deps are work_complete+merged', () => {
    const graph = buildGraph([
      createFeatureFixture({
        id: 'f-a',
        workControl: 'work_complete',
        collabControl: 'merged',
        status: 'done',
      }),
      createFeatureFixture({
        id: 'f-b',
        workControl: 'executing',
        collabControl: 'branch_open',
        dependsOn: ['f-a'],
      }),
    ]);
    expect(hasUnmergedFeatureDep(graph, 'f-b')).toEqual({ unmerged: false });
  });

  it('returns not unmerged for features with no deps', () => {
    const graph = buildGraph([
      createFeatureFixture({
        id: 'f-a',
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
    ]);
    expect(hasUnmergedFeatureDep(graph, 'f-a')).toEqual({ unmerged: false });
  });

  it('returns not unmerged when feature does not exist', () => {
    const graph = buildGraph([]);
    expect(hasUnmergedFeatureDep(graph, 'f-missing')).toEqual({
      unmerged: false,
    });
  });
});

describe('dispatchReadyWork unmerged-dep guard', () => {
  function setupReadyTask(depMerged: boolean): {
    graph: InMemoryFeatureGraph;
    ports: OrchestratorPorts;
    warnSpy: ReturnType<typeof vi.spyOn>;
  } {
    const dep = createFeatureFixture({
      id: 'f-a',
      ...(depMerged
        ? {
            workControl: 'work_complete' as const,
            collabControl: 'merged' as const,
            status: 'done' as const,
          }
        : {
            workControl: 'executing' as const,
            collabControl: 'branch_open' as const,
          }),
    });
    const feat = createFeatureFixture({
      id: 'f-b',
      workControl: 'executing',
      collabControl: 'branch_open',
      dependsOn: ['f-a'],
    });
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-b',
      status: 'ready',
      collabControl: 'branch_open',
    });
    const graph = buildGraph([dep, feat], [task]);

    const dispatchTask = vi.fn(() => Promise.resolve({ kind: 'delivered' }));
    const ports = {
      runtime: {
        idleWorkerCount: () => 1,
        dispatchTask,
        dispatchRun: vi.fn(() => Promise.resolve({ kind: 'delivered' })),
      },
      store: {
        listAgentRuns: () => [],
        createAgentRun: vi.fn(),
        getAgentRun: () => undefined,
        updateAgentRun: vi.fn(),
        appendEvent: vi.fn(),
      },
      worktree: {
        ensureFeatureBranch: () => Promise.resolve(),
        ensureFeatureWorktree: () => Promise.resolve('/tmp/wt'),
        ensureTaskWorktree: () => Promise.resolve('/tmp/wt'),
      },
      sessionStore: { getSession: () => undefined, putSession: vi.fn() },
      ui: { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() },
      config: { tokenProfile: 'balanced' as const },
    } as unknown as OrchestratorPorts;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return { graph, ports, warnSpy };
  }

  it('skips task whose feature has unmerged feature dep and logs warn', async () => {
    const { graph, ports, warnSpy } = setupReadyTask(false);
    await dispatchReadyWork({
      graph,
      ports,
      now: 1,
      autoExecutionEnabled: true,
      readySince: new Map(),
      handleEvent: () => Promise.resolve(),
      markTaskRunning: () => {},
      markFeaturePhaseRunning: () => {},
    });
    expect(ports.runtime.dispatchTask).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[scheduler] dispatch guard: task t-1 for feature f-b has unmerged dep f-a',
      ),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when dep is merged', async () => {
    const { graph, ports, warnSpy } = setupReadyTask(true);
    await dispatchReadyWork({
      graph,
      ports,
      now: 1,
      autoExecutionEnabled: true,
      readySince: new Map(),
      handleEvent: () => Promise.resolve(),
      markTaskRunning: () => {},
      markFeaturePhaseRunning: () => {},
    }).catch(() => {
      // dispatchTaskUnit may throw on missing store wiring; the guard
      // either passes or short-circuits before it. Either way, the
      // dispatch-guard's own warn must not fire.
    });
    const warnCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('[scheduler] dispatch guard:'),
    );
    expect(warnCalls).toEqual([]);
    warnSpy.mockRestore();
  });
});
