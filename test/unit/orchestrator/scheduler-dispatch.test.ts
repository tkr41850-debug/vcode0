import { type FeatureGraph, InMemoryFeatureGraph } from '@core/graph/index';
import {
  prioritizeReadyWork,
  type SchedulableUnit,
} from '@core/scheduling/index';
import {
  type Feature,
  PROJECT_SCOPE_ID,
  type ProjectAgentRun,
  type Task,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { dispatchProjectRunUnit } from '@orchestrator/scheduler/dispatch';
import type {
  DispatchRunResult,
  ProjectRunPayload,
  RunPayload,
  RunScope,
  RuntimeDispatch,
} from '@runtime/contracts';
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

function makeProjectRun(overrides?: Partial<ProjectAgentRun>): ProjectAgentRun {
  return {
    id: 'run-project:r1',
    scopeType: 'project',
    scopeId: PROJECT_SCOPE_ID,
    phase: 'plan',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makePorts(
  dispatchRun: (
    scope: RunScope,
    dispatch: RuntimeDispatch,
    payload: RunPayload,
  ) => Promise<DispatchRunResult>,
  worktreeSpies: {
    ensureFeatureWorktree: ReturnType<typeof vi.fn>;
    ensureFeatureBranch: ReturnType<typeof vi.fn>;
  },
): OrchestratorPorts {
  return {
    runtime: {
      idleWorkerCount: () => 1,
      dispatchTask: vi.fn(),
      dispatchRun: vi.fn(dispatchRun),
    },
    store: {
      listAgentRuns: () => [],
      createAgentRun: vi.fn(),
      getAgentRun: () => undefined,
      updateAgentRun: vi.fn(),
      appendEvent: vi.fn(),
    },
    worktree: {
      ensureFeatureBranch: worktreeSpies.ensureFeatureBranch,
      ensureFeatureWorktree: worktreeSpies.ensureFeatureWorktree,
      ensureTaskWorktree: vi.fn(() => Promise.resolve('/tmp/wt')),
    },
    sessionStore: { getSession: () => undefined, putSession: vi.fn() },
    ui: { show: vi.fn(), refresh: vi.fn(), dispose: vi.fn() },
    config: { tokenProfile: 'balanced' as const },
  } as unknown as OrchestratorPorts;
}

describe('dispatchProjectRunUnit', () => {
  it('routes through RuntimePort.dispatchRun with project scope and run id', async () => {
    const run = makeProjectRun();
    const dispatchRun = vi.fn(
      (
        _scope: RunScope,
        _dispatch: RuntimeDispatch,
        _payload: RunPayload,
      ): Promise<DispatchRunResult> =>
        Promise.resolve({
          kind: 'awaiting_approval',
          agentRunId: run.id,
          sessionId: run.id,
          output: {
            kind: 'proposal',
            phase: 'plan',
            result: {
              summary: 'project proposal',
              proposal: { version: 1, mode: 'plan', aliases: {}, ops: [] },
              details: { summary: 'project proposal' },
            },
          },
        } as unknown as DispatchRunResult),
    );
    const ensureFeatureWorktree = vi.fn(() => Promise.resolve('/tmp/wt'));
    const ensureFeatureBranch = vi.fn(() => Promise.resolve());
    const ports = makePorts(dispatchRun, {
      ensureFeatureWorktree,
      ensureFeatureBranch,
    });

    await dispatchProjectRunUnit({
      run,
      ports,
      graph: { graphVersion: 0 } as unknown as FeatureGraph,
      handleEvent: () => Promise.resolve(),
    });

    expect(dispatchRun).toHaveBeenCalledTimes(1);
    const [scopeArg, dispatchArg, payloadArg] = dispatchRun.mock
      .calls[0] as unknown as [RunScope, RuntimeDispatch, RunPayload];
    expect(scopeArg).toEqual({ kind: 'project' });
    expect(dispatchArg).toMatchObject({
      mode: 'start',
      agentRunId: run.id,
    });
    expect((payloadArg as ProjectRunPayload).kind).toBe('project');
    expect(ensureFeatureWorktree).not.toHaveBeenCalled();
    expect(ensureFeatureBranch).not.toHaveBeenCalled();
  });

  it('passes resume dispatch when project run already has a sessionId', async () => {
    const run = makeProjectRun({
      runStatus: 'await_approval',
      sessionId: 'sess-existing',
    });
    const dispatchRun = vi.fn(
      (): Promise<DispatchRunResult> =>
        Promise.resolve({
          kind: 'awaiting_approval',
          agentRunId: run.id,
          sessionId: 'sess-existing',
          output: {
            kind: 'proposal',
            phase: 'plan',
            result: {
              summary: 'r',
              proposal: { version: 1, mode: 'plan', aliases: {}, ops: [] },
              details: { summary: 'r' },
            },
          },
        } as unknown as DispatchRunResult),
    );
    const ports = makePorts(dispatchRun, {
      ensureFeatureWorktree: vi.fn(),
      ensureFeatureBranch: vi.fn(),
    });

    await dispatchProjectRunUnit({
      run,
      ports,
      graph: { graphVersion: 0 } as unknown as FeatureGraph,
      handleEvent: () => Promise.resolve(),
    });

    const [, dispatchArg] = dispatchRun.mock.calls[0] as unknown as [
      RunScope,
      RuntimeDispatch,
      RunPayload,
    ];
    expect(dispatchArg).toMatchObject({
      mode: 'resume',
      agentRunId: run.id,
      sessionId: 'sess-existing',
    });
  });
});

describe('prioritizeReadyWork — project regression guard', () => {
  it('never returns project_run entries; SchedulableUnit stays task | feature_phase', () => {
    const graph = buildGraph(
      [
        createFeatureFixture({
          id: 'f-a',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-a',
          status: 'ready',
          collabControl: 'branch_open',
        }),
      ],
    );
    const ready = prioritizeReadyWork(
      graph,
      { getExecutionRun: () => undefined },
      { nodeMetrics: new Map() },
      1,
      new Map(),
    );

    for (const unit of ready) {
      // Type-level: SchedulableUnit['kind'] should not include 'project_run'.
      const k: 'task' | 'feature_phase' = unit.kind;
      expect(k).toBeDefined();
    }
    const kinds: SchedulableUnit['kind'][] = ready.map((u) => u.kind);
    expect(kinds).not.toContain('project_run' as never);
  });
});
