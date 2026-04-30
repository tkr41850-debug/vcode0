import type { GraphSnapshot } from '@core/graph/index';
import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import type { ProposalPhaseDetails } from '@core/types/index';
import type { ProposalOpScopeRef } from '@orchestrator/ports/index';
import { TuiApp, type TuiAppDeps } from '@tui/app';
import { describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

const featureF1 = createFeatureFixture({
  id: 'f-1',
  name: 'Feature 1',
  workControl: 'planning',
});
const milestoneM1 = createMilestoneFixture();

const authoritativeSnapshot: GraphSnapshot = {
  milestones: [milestoneM1],
  features: [featureF1],
  tasks: [],
};

function liveSnapshotWithExtra(): GraphSnapshot {
  return {
    milestones: [milestoneM1],
    features: [
      featureF1,
      createFeatureFixture({ id: 'f-2', name: 'Live planner add' }),
    ],
    tasks: [],
  };
}

function createStubDeps(overrides: Partial<TuiAppDeps> = {}): TuiAppDeps {
  return {
    snapshot: () => authoritativeSnapshot,
    listAgentRuns: () => [],
    getWorkerCounts: () => ({
      runningWorkers: 0,
      idleWorkers: 1,
      totalWorkers: 1,
    }),
    isAutoExecutionEnabled: () => false,
    setAutoExecutionEnabled: () => false,
    toggleAutoExecution: () => false,
    toggleMilestoneQueue: () => {},
    initializeProject: vi.fn(() => ({
      milestoneId: 'm-1' as const,
      featureId: 'f-1' as const,
    })),
    cancelFeature: () => Promise.resolve(),
    saveFeatureRun: () => {},
    getFeatureRun: () => undefined,
    getTaskRun: () => undefined,
    enqueueApprovalDecision: () => {},
    rerunFeatureProposal: () => {},
    respondToTaskHelp: () => Promise.resolve(''),
    decideTaskApproval: () => Promise.resolve(''),
    sendTaskManualInput: () => Promise.resolve(''),
    sendPlannerChatInput: () => Promise.resolve(''),
    respondToFeaturePhaseHelp: () => Promise.resolve(''),
    listPendingFeaturePhaseHelp: () => [],
    attachFeaturePhaseRun: () => Promise.resolve(''),
    releaseFeaturePhaseToScheduler: () => Promise.resolve(''),
    quit: () => Promise.resolve(),
    ...overrides,
  };
}

const scopeF1: ProposalOpScopeRef = {
  featureId: 'f-1',
  phase: 'plan',
  agentRunId: 'run-feature:f-1:plan',
};

const dummyOp: GraphProposalOp = {
  kind: 'add_milestone',
  milestoneId: 'm-2',
  name: 'M2',
  description: 'd',
};

const dummyProposal: GraphProposal = {
  version: 1,
  mode: 'plan',
  aliases: {},
  ops: [],
};

const dummyDetails: ProposalPhaseDetails = {
  summary: 'Plan ready.',
  chosenApproach: 'a',
  keyConstraints: [],
  decompositionRationale: [],
  orderingRationale: [],
  verificationExpectations: [],
  risksTradeoffs: [],
  assumptions: [],
};

describe('TuiApp live-planner wiring', () => {
  it('onProposalOp updates session store and resolves active entry when feature selected', () => {
    const app = new TuiApp(createStubDeps());
    app.setSelectedNodeIdForTests('f-1');

    expect(app.getLivePlannerStateForTests()).toEqual({
      sessionCount: 0,
      activeEntry: undefined,
    });

    app.onProposalOp(scopeF1, dummyOp, liveSnapshotWithExtra());

    const state = app.getLivePlannerStateForTests();
    expect(state.sessionCount).toBe(1);
    expect(state.activeEntry).toMatchObject({
      scope: scopeF1,
      opCount: 1,
      submissionCount: 0,
    });
    expect(state.activeEntry?.snapshot.features).toHaveLength(2);
  });

  it('onProposalOp does not surface entry when selection is on different feature', () => {
    const app = new TuiApp(createStubDeps());
    app.setSelectedNodeIdForTests('m-1'); // milestone, not f-1

    app.onProposalOp(scopeF1, dummyOp, liveSnapshotWithExtra());

    const state = app.getLivePlannerStateForTests();
    expect(state.sessionCount).toBe(1);
    expect(state.activeEntry).toBeUndefined();
  });

  it('onProposalSubmitted increments submission count visible via active entry', () => {
    const app = new TuiApp(createStubDeps());
    app.setSelectedNodeIdForTests('f-1');

    app.onProposalOp(scopeF1, dummyOp, liveSnapshotWithExtra());
    app.onProposalSubmitted(scopeF1, dummyDetails, dummyProposal, 1);

    const state = app.getLivePlannerStateForTests();
    expect(state.activeEntry).toMatchObject({
      opCount: 1,
      submissionCount: 1,
    });
  });

  it('onProposalPhaseEnded clears the entry', () => {
    const app = new TuiApp(createStubDeps());
    app.setSelectedNodeIdForTests('f-1');

    app.onProposalOp(scopeF1, dummyOp, liveSnapshotWithExtra());
    expect(app.getLivePlannerStateForTests().sessionCount).toBe(1);

    app.onProposalPhaseEnded(scopeF1, 'completed');

    expect(app.getLivePlannerStateForTests()).toEqual({
      sessionCount: 0,
      activeEntry: undefined,
    });
  });

  it('handlers each fire refresh exactly once', () => {
    const app = new TuiApp(createStubDeps());
    app.setSelectedNodeIdForTests('f-1');
    let refreshCount = 0;
    const original = app.refresh.bind(app);
    app.refresh = () => {
      refreshCount += 1;
      original();
    };

    app.onProposalOp(scopeF1, dummyOp, liveSnapshotWithExtra());
    expect(refreshCount).toBe(1);

    app.onProposalSubmitted(scopeF1, dummyDetails, dummyProposal, 1);
    expect(refreshCount).toBe(2);

    app.onProposalPhaseEnded(scopeF1, 'completed');
    expect(refreshCount).toBe(3);
  });
});
