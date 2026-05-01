import { InMemoryFeatureGraph } from '@core/graph/index';
import type { GraphProposal } from '@core/proposals/index';
import { PROJECT_SCOPE_ID, type ProjectAgentRun } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { serializeStoredProposalPayload } from '@orchestrator/proposals/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function buildEmptyProposal(): GraphProposal {
  return { version: 1, mode: 'plan', aliases: {}, ops: [] };
}

function buildEditProposal(): GraphProposal {
  return {
    version: 1,
    mode: 'plan',
    aliases: {},
    ops: [
      {
        kind: 'edit_feature',
        featureId: 'f-1',
        patch: { featureObjective: 'do thing' },
      },
    ],
  };
}

function makeProjectRun(
  overrides: Partial<ProjectAgentRun> = {},
): ProjectAgentRun {
  return {
    id: 'run-project:sess1',
    scopeType: 'project',
    scopeId: PROJECT_SCOPE_ID,
    phase: 'plan',
    runStatus: 'await_approval',
    owner: 'system',
    attention: 'operator',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

interface Deps {
  graph: InMemoryFeatureGraph;
  ports: OrchestratorPorts;
  features: FeatureLifecycleCoordinator;
  conflicts: ConflictCoordinator;
  summaries: SummaryCoordinator;
  appendedEvents: Array<{ eventType: string; payload?: unknown }>;
  updates: Array<{ id: string; patch: Partial<ProjectAgentRun> }>;
}

function buildDeps(run: ProjectAgentRun): Deps {
  const graph = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [createFeatureFixture({ id: 'f-1', workControl: 'planning' })],
    tasks: [],
  });

  const appendedEvents: Array<{ eventType: string; payload?: unknown }> = [];
  const updates: Array<{ id: string; patch: Partial<ProjectAgentRun> }> = [];

  const store = {
    getProjectSession: vi.fn(() => run),
    listAgentRuns: vi.fn(() => [run]),
    updateAgentRun: vi.fn(
      (id: string, patch: Partial<ProjectAgentRun>): void => {
        updates.push({ id, patch });
        Object.assign(run, patch);
      },
    ),
    appendEvent: vi.fn((event: { eventType: string; payload?: unknown }) => {
      appendedEvents.push(event);
    }),
  };

  const ports = {
    store,
    runtime: {
      dispatchTask: vi.fn(),
      dispatchRun: vi.fn(),
      idleWorkerCount: vi.fn(() => 1),
    },
  } as unknown as OrchestratorPorts;

  return {
    graph,
    ports,
    features: {} as unknown as FeatureLifecycleCoordinator,
    conflicts: {} as unknown as ConflictCoordinator,
    summaries: {} as unknown as SummaryCoordinator,
    appendedEvents,
    updates,
  };
}

describe('handleSchedulerEvent — project_approval_decision', () => {
  it('approved + matching baseline applies and completes the project run', async () => {
    const run = makeProjectRun({
      payloadJson: serializeStoredProposalPayload({
        proposal: buildEditProposal(),
        baselineGraphVersion: 0,
      }),
    });
    const deps = buildDeps(run);
    expect(deps.graph.graphVersion).toBe(0);

    await handleSchedulerEvent({
      event: {
        type: 'project_approval_decision',
        runId: run.id,
        decision: 'approved',
      },
      graph: deps.graph,
      ports: deps.ports,
      features: deps.features,
      conflicts: deps.conflicts,
      summaries: deps.summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    expect(deps.graph.graphVersion).toBe(1);
    const completion = deps.updates.find(
      (u) => u.patch.runStatus === 'completed',
    );
    expect(completion).toBeDefined();
    const applied = deps.appendedEvents.find(
      (e) => e.eventType === 'project_proposal_applied',
    );
    expect(applied).toBeDefined();
  });

  it('approved + stale baseline returns run to running with rebase reason in payload', async () => {
    const run = makeProjectRun({
      payloadJson: serializeStoredProposalPayload({
        proposal: buildEditProposal(),
        baselineGraphVersion: 0,
      }),
    });
    const deps = buildDeps(run);
    deps.graph.bumpGraphVersion();
    expect(deps.graph.graphVersion).toBe(1);

    await handleSchedulerEvent({
      event: {
        type: 'project_approval_decision',
        runId: run.id,
        decision: 'approved',
      },
      graph: deps.graph,
      ports: deps.ports,
      features: deps.features,
      conflicts: deps.conflicts,
      summaries: deps.summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    const rebaseUpdate = deps.updates.find(
      (u) => u.patch.runStatus === 'running',
    );
    expect(rebaseUpdate).toBeDefined();
    const rebaseEvent = deps.appendedEvents.find(
      (e) => e.eventType === 'project_proposal_rebase',
    );
    expect(rebaseEvent).toBeDefined();
    const reason = (rebaseEvent?.payload as { reason: { kind: string } })
      .reason;
    expect(reason.kind).toBe('stale-baseline');
  });

  it('rejected decision moves run to cancelled and emits proposal_rejected event', async () => {
    const run = makeProjectRun({
      payloadJson: serializeStoredProposalPayload({
        proposal: buildEmptyProposal(),
        baselineGraphVersion: 0,
      }),
    });
    const deps = buildDeps(run);

    await handleSchedulerEvent({
      event: {
        type: 'project_approval_decision',
        runId: run.id,
        decision: 'rejected',
        comment: 'no thanks',
      },
      graph: deps.graph,
      ports: deps.ports,
      features: deps.features,
      conflicts: deps.conflicts,
      summaries: deps.summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    const cancellation = deps.updates.find(
      (u) => u.patch.runStatus === 'cancelled',
    );
    expect(cancellation).toBeDefined();
    const rejected = deps.appendedEvents.find(
      (e) => e.eventType === 'project_proposal_rejected',
    );
    expect(rejected).toBeDefined();
  });

  it('approved with missing baselineGraphVersion logs apply_failed and does not mutate graph', async () => {
    const run = makeProjectRun({
      payloadJson: JSON.stringify({ proposal: buildEditProposal() }),
    });
    const deps = buildDeps(run);

    await handleSchedulerEvent({
      event: {
        type: 'project_approval_decision',
        runId: run.id,
        decision: 'approved',
      },
      graph: deps.graph,
      ports: deps.ports,
      features: deps.features,
      conflicts: deps.conflicts,
      summaries: deps.summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    expect(deps.graph.graphVersion).toBe(0);
    const failed = deps.appendedEvents.find(
      (e) => e.eventType === 'project_proposal_apply_failed',
    );
    expect(failed).toBeDefined();
  });

  it('skips routing when run is not in await_approval', async () => {
    const run = makeProjectRun({
      runStatus: 'running',
      payloadJson: serializeStoredProposalPayload({
        proposal: buildEditProposal(),
        baselineGraphVersion: 0,
      }),
    });
    const deps = buildDeps(run);

    await handleSchedulerEvent({
      event: {
        type: 'project_approval_decision',
        runId: run.id,
        decision: 'approved',
      },
      graph: deps.graph,
      ports: deps.ports,
      features: deps.features,
      conflicts: deps.conflicts,
      summaries: deps.summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    expect(deps.updates.length).toBe(0);
    expect(deps.graph.graphVersion).toBe(0);
  });
});
