import type { FeatureGraph } from '@core/graph/index';
import { PROJECT_SCOPE_ID, type ProjectAgentRun } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ProjectPlannerCoordinator } from '@orchestrator/services/project-planner-coordinator';
import { describe, expect, it, vi } from 'vitest';

const stubGraph = { graphVersion: 0 } as unknown as FeatureGraph;

function makePorts(overrides?: {
  runs?: Map<string, ProjectAgentRun>;
  abortRun?: ReturnType<typeof vi.fn>;
}): OrchestratorPorts {
  const runs = overrides?.runs ?? new Map<string, ProjectAgentRun>();
  return {
    runtime: {
      idleWorkerCount: () => 1,
      dispatchTask: vi.fn(),
      dispatchRun: vi.fn(),
      abortRun: overrides?.abortRun ?? vi.fn(),
    },
    store: {
      listAgentRuns: () => [],
      createAgentRun: vi.fn((run: ProjectAgentRun) => {
        runs.set(run.id, run);
      }),
      getAgentRun: (id: string) => runs.get(id),
      getProjectSession: (id: string) => runs.get(id),
      listProjectSessions: () => [...runs.values()],
      updateAgentRun: vi.fn((id: string, patch: Partial<ProjectAgentRun>) => {
        const existing = runs.get(id);
        if (existing === undefined) throw new Error(`missing run ${id}`);
        runs.set(id, { ...existing, ...patch });
      }),
      appendEvent: vi.fn(),
    },
    config: { tokenProfile: 'balanced' as const },
  } as unknown as OrchestratorPorts;
}

describe('ProjectPlannerCoordinator.startProjectPlannerSession', () => {
  it('writes a project agent_runs row and dispatches once', async () => {
    const dispatchFn = vi.fn(() => Promise.resolve());
    const ports = makePorts();
    const coord = new ProjectPlannerCoordinator(
      ports,
      stubGraph,
      () => Promise.resolve(),
      { dispatchFn, idGen: () => 'sess1' },
    );

    const id = await coord.startProjectPlannerSession();

    expect(id).toBe('run-project:sess1');
    expect(ports.store.createAgentRun).toHaveBeenCalledTimes(1);
    const created = (ports.store.createAgentRun as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as ProjectAgentRun;
    expect(created.scopeType).toBe('project');
    expect(created.scopeId).toBe(PROJECT_SCOPE_ID);
    expect(created.runStatus).toBe('running');
    expect(created.owner).toBe('system');
    expect(created.phase).toBe('plan');
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    const params = (
      dispatchFn.mock.calls as unknown as Array<[{ run: ProjectAgentRun }]>
    )[0]?.[0];
    expect(params?.run.id).toBe('run-project:sess1');
  });
});

describe('ProjectPlannerCoordinator.resumeProjectPlannerSession', () => {
  function setupRun(overrides: Partial<ProjectAgentRun>): {
    coord: ProjectPlannerCoordinator;
    dispatchFn: ReturnType<typeof vi.fn>;
    ports: OrchestratorPorts;
  } {
    const run: ProjectAgentRun = {
      id: 'run-project:sess1',
      scopeType: 'project',
      scopeId: PROJECT_SCOPE_ID,
      phase: 'plan',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
      ...overrides,
    };
    const runs = new Map([[run.id, run]]);
    const ports = makePorts({ runs });
    const dispatchFn = vi.fn(() => Promise.resolve());
    const coord = new ProjectPlannerCoordinator(
      ports,
      stubGraph,
      () => Promise.resolve(),
      { dispatchFn, idGen: () => 'sess1' },
    );
    return { coord, dispatchFn, ports };
  }

  it('re-dispatches a running session', async () => {
    const { coord, dispatchFn } = setupRun({ runStatus: 'running' });
    await coord.resumeProjectPlannerSession('run-project:sess1');
    expect(dispatchFn).toHaveBeenCalledTimes(1);
  });

  it('no-ops on await_approval', async () => {
    const { coord, dispatchFn } = setupRun({ runStatus: 'await_approval' });
    await coord.resumeProjectPlannerSession('run-project:sess1');
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it('no-ops on await_response', async () => {
    const { coord, dispatchFn } = setupRun({ runStatus: 'await_response' });
    await coord.resumeProjectPlannerSession('run-project:sess1');
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it('rejects on failed', async () => {
    const { coord, dispatchFn } = setupRun({ runStatus: 'failed' });
    await expect(
      coord.resumeProjectPlannerSession('run-project:sess1'),
    ).rejects.toThrow(/cannot be resumed/);
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it('rejects on cancelled', async () => {
    const { coord, dispatchFn } = setupRun({ runStatus: 'cancelled' });
    await expect(
      coord.resumeProjectPlannerSession('run-project:sess1'),
    ).rejects.toThrow(/cannot be resumed/);
    expect(dispatchFn).not.toHaveBeenCalled();
  });
});

describe('ProjectPlannerCoordinator.cancelProjectPlannerSession', () => {
  it('moves a running session to cancelled and aborts the worker', async () => {
    const run: ProjectAgentRun = {
      id: 'run-project:sess1',
      scopeType: 'project',
      scopeId: PROJECT_SCOPE_ID,
      phase: 'plan',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    const runs = new Map([[run.id, run]]);
    const abortRun = vi.fn(() =>
      Promise.resolve({ kind: 'delivered' as const }),
    );
    const ports = makePorts({ runs, abortRun });
    const coord = new ProjectPlannerCoordinator(
      ports,
      stubGraph,
      () => Promise.resolve(),
      { dispatchFn: vi.fn(), idGen: () => 'sess1' },
    );

    await coord.cancelProjectPlannerSession('run-project:sess1');

    expect(abortRun).toHaveBeenCalledWith('run-project:sess1');
    expect(ports.store.updateAgentRun).toHaveBeenCalledWith(
      'run-project:sess1',
      expect.objectContaining({ runStatus: 'cancelled' }),
    );
  });

  it('is a no-op on terminal states', async () => {
    const run: ProjectAgentRun = {
      id: 'run-project:sess1',
      scopeType: 'project',
      scopeId: PROJECT_SCOPE_ID,
      phase: 'plan',
      runStatus: 'completed',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    const runs = new Map([[run.id, run]]);
    const abortRun = vi.fn();
    const ports = makePorts({ runs, abortRun });
    const coord = new ProjectPlannerCoordinator(
      ports,
      stubGraph,
      () => Promise.resolve(),
      { dispatchFn: vi.fn(), idGen: () => 'sess1' },
    );

    await coord.cancelProjectPlannerSession('run-project:sess1');

    expect(abortRun).not.toHaveBeenCalled();
    expect(ports.store.updateAgentRun).not.toHaveBeenCalled();
  });
});
