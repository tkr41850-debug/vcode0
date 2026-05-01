import type { GraphSnapshot } from '@core/graph/index';
import type { FeaturePhaseAgentRun } from '@core/types/index';
import type { TuiAppDeps } from '@tui/app';
import { executeSlashCommand, routePlainTextInput } from '@tui/app-composer';
import type { ComposerProposalController } from '@tui/proposal-controller';
import { describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function buildSnapshot(
  workControl: 'planning' | 'replanning' | 'executing',
): GraphSnapshot {
  return {
    milestones: [createMilestoneFixture()],
    features: [createFeatureFixture({ id: 'f-1', workControl })],
    tasks: [],
  };
}

function buildRun(
  phase: 'plan' | 'replan',
  runStatus: FeaturePhaseAgentRun['runStatus'],
): FeaturePhaseAgentRun {
  return {
    id: `run-feature:f-1:${phase}`,
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase,
    runStatus,
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
  };
}

function buildDataSource(overrides: Partial<TuiAppDeps> = {}): TuiAppDeps & {
  sendPlannerChatInput: ReturnType<typeof vi.fn>;
} {
  const sendPlannerChatInput = vi.fn<TuiAppDeps['sendPlannerChatInput']>(() =>
    Promise.resolve('sent to planner'),
  );
  return {
    snapshot: () => buildSnapshot('planning'),
    listAgentRuns: () => [],
    getWorkerCounts: () => ({
      runningWorkers: 0,
      idleWorkers: 1,
      totalWorkers: 1,
    }),
    isAutoExecutionEnabled: () => false,
    setAutoExecutionEnabled: () => false,
    toggleAutoExecution: () => false,
    initializeProject: () => Promise.resolve({ kind: 'existing' as const }),
    toggleMilestoneQueue: () => {},
    cancelFeature: () => Promise.resolve(),
    saveFeatureRun: () => {},
    getFeatureRun: () => undefined,
    getTaskRun: () => undefined,
    enqueueApprovalDecision: () => {},
    rerunFeatureProposal: () => {},
    respondToTaskHelp: () => Promise.resolve(''),
    decideTaskApproval: () => Promise.resolve(''),
    sendTaskManualInput: () => Promise.resolve(''),
    sendPlannerChatInput,
    respondToFeaturePhaseHelp: () => Promise.resolve(''),
    listPendingFeaturePhaseHelp: () => [],
    attachFeaturePhaseRun: () => Promise.resolve(''),
    releaseFeaturePhaseToScheduler: () => Promise.resolve(''),
    quit: () => Promise.resolve(),
    ...overrides,
  } as TuiAppDeps & { sendPlannerChatInput: ReturnType<typeof vi.fn> };
}

describe('routePlainTextInput', () => {
  it('routes to sendPlannerChatInput on planning feature with running plan run', async () => {
    const dataSource = buildDataSource({
      getFeatureRun: (_id, phase) =>
        phase === 'plan' ? buildRun('plan', 'running') : undefined,
    });

    const message = await routePlainTextInput({
      text: 'revise t-1 reservedWritePaths',
      selection: { featureId: 'f-1' },
      snapshot: buildSnapshot('planning'),
      dataSource,
      draftActive: false,
    });

    expect(dataSource.sendPlannerChatInput).toHaveBeenCalledWith(
      'f-1',
      'plan',
      'revise t-1 reservedWritePaths',
    );
    expect(message).toBe('sent to planner');
  });

  it('routes to replan when feature is in replanning state', async () => {
    const dataSource = buildDataSource({
      getFeatureRun: (_id, phase) =>
        phase === 'replan' ? buildRun('replan', 'running') : undefined,
    });

    const message = await routePlainTextInput({
      text: 'try alternate approach',
      selection: { featureId: 'f-1' },
      snapshot: buildSnapshot('replanning'),
      dataSource,
      draftActive: false,
    });

    expect(dataSource.sendPlannerChatInput).toHaveBeenCalledWith(
      'f-1',
      'replan',
      'try alternate approach',
    );
    expect(message).toBe('sent to planner');
  });

  it('returns helpful notice when feature is not in planning/replanning state', async () => {
    const dataSource = buildDataSource();

    const message = await routePlainTextInput({
      text: 'hello',
      selection: { featureId: 'f-1' },
      snapshot: buildSnapshot('executing'),
      dataSource,
      draftActive: false,
    });

    expect(dataSource.sendPlannerChatInput).not.toHaveBeenCalled();
    expect(message).toMatch(/planner not running/i);
  });

  it('returns helpful notice when planner run is missing or not running', async () => {
    const dataSource = buildDataSource({
      getFeatureRun: () => buildRun('plan', 'await_approval'),
    });

    const message = await routePlainTextInput({
      text: 'hello',
      selection: { featureId: 'f-1' },
      snapshot: buildSnapshot('planning'),
      dataSource,
      draftActive: false,
    });

    expect(dataSource.sendPlannerChatInput).not.toHaveBeenCalled();
    expect(message).toMatch(/planner not running/i);
  });

  it('returns helpful notice when no feature is selected', async () => {
    const dataSource = buildDataSource();

    const message = await routePlainTextInput({
      text: 'hello',
      selection: {},
      snapshot: buildSnapshot('planning'),
      dataSource,
      draftActive: false,
    });

    expect(dataSource.sendPlannerChatInput).not.toHaveBeenCalled();
    expect(message).toMatch(/select.+feature/i);
  });

  it('blocks chat with notice when manual draft is active even if planner is running', async () => {
    const dataSource = buildDataSource({
      getFeatureRun: (_id, phase) =>
        phase === 'plan' ? buildRun('plan', 'running') : undefined,
    });

    const message = await routePlainTextInput({
      text: 'should not reach planner',
      selection: { featureId: 'f-1' },
      snapshot: buildSnapshot('planning'),
      dataSource,
      draftActive: true,
    });

    expect(dataSource.sendPlannerChatInput).not.toHaveBeenCalled();
    expect(message).toMatch(/discard.+draft/i);
  });

  it('returns helpful notice when selected feature is not in snapshot', async () => {
    const dataSource = buildDataSource();

    const message = await routePlainTextInput({
      text: 'hello',
      selection: { featureId: 'f-99' as never },
      snapshot: buildSnapshot('planning'),
      dataSource,
      draftActive: false,
    });

    expect(dataSource.sendPlannerChatInput).not.toHaveBeenCalled();
    expect(message).toMatch(/not found|planner not running/i);
  });
});

describe('executeSlashCommand /init', () => {
  function buildCommandContext() {
    return {
      toggleAutoExecution: vi.fn(),
      toggleMilestoneQueue: vi.fn(),
      toggleAgentMonitor: vi.fn(),
      selectNextWorker: vi.fn(),
      toggleHelp: vi.fn(),
      toggleDependencyDetail: vi.fn(),
      cancelSelectedFeature: vi.fn(() => Promise.resolve()),
      requestQuit: vi.fn(),
    };
  }

  function buildProposalController(): ComposerProposalController {
    return {} as ComposerProposalController;
  }

  it('forwards greenfield-bootstrap result to user-facing notice with sessionId', async () => {
    const initializeProject = vi.fn(() =>
      Promise.resolve({
        kind: 'greenfield-bootstrap' as const,
        sessionId: 'run-project:abc123',
      }),
    );
    const dataSource = buildDataSource({ initializeProject });

    const message = await executeSlashCommand({
      input:
        '/init --milestone-name m --milestone-description md --feature-name f --feature-description fd',
      commandContext: buildCommandContext(),
      notice: undefined,
      dataSource,
      proposalController: buildProposalController(),
      currentSelection: {},
      setSelectedNodeId: vi.fn(),
    });

    expect(initializeProject).toHaveBeenCalledTimes(1);
    expect(message).toMatch(/run-project:abc123/);
    expect(message).toMatch(/started/i);
  });

  it('forwards existing result to a benign already-initialized notice', async () => {
    const initializeProject = vi.fn(() =>
      Promise.resolve({ kind: 'existing' as const }),
    );
    const dataSource = buildDataSource({ initializeProject });

    const message = await executeSlashCommand({
      input:
        '/init --milestone-name m --milestone-description md --feature-name f --feature-description fd',
      commandContext: buildCommandContext(),
      notice: undefined,
      dataSource,
      proposalController: buildProposalController(),
      currentSelection: {},
      setSelectedNodeId: vi.fn(),
    });

    expect(initializeProject).toHaveBeenCalledTimes(1);
    expect(message).toMatch(/already initialized/i);
  });

  it('does not dereference featureId on bootstrap result (typed greenfield-bootstrap has no featureId field)', async () => {
    const setSelectedNodeId = vi.fn();
    const initializeProject = vi.fn(() =>
      Promise.resolve({
        kind: 'greenfield-bootstrap' as const,
        sessionId: 'run-project:zzz',
      }),
    );
    const dataSource = buildDataSource({ initializeProject });

    await executeSlashCommand({
      input:
        '/init --milestone-name m --milestone-description md --feature-name f --feature-description fd',
      commandContext: buildCommandContext(),
      notice: undefined,
      dataSource,
      proposalController: buildProposalController(),
      currentSelection: {},
      setSelectedNodeId,
    });

    expect(setSelectedNodeId).not.toHaveBeenCalled();
  });
});
