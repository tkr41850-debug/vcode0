import { GraphValidationError, InMemoryFeatureGraph } from '@core/graph/index';
import type { GvcConfig, VerificationSummary } from '@core/types/index';
import { rebaseGitDir } from '@orchestrator/conflicts/git.js';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import type { MergeTrainScenario } from './harness/merge-train-scenario.js';
import { createMergeTrainScenario } from './harness/merge-train-scenario.js';
import { InMemoryStore } from './harness/store-memory.js';

vi.mock('../../src/orchestrator/conflicts/git.js', () => ({
  rebaseGitDir: vi.fn(),
  rebaseTaskWorktree: vi.fn(),
  fileExists: vi.fn(),
  abortRebase: vi.fn(),
  readConflictedFiles: vi.fn(),
  readDirtyFiles: vi.fn(),
}));
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(),
}));

describe('merge train integration (persistent graph)', () => {
  let scenario: MergeTrainScenario;

  beforeEach(() => {
    scenario = createMergeTrainScenario();
  });

  afterEach(() => {
    scenario.close();
  });

  describe('serialization and ordering', () => {
    it('only one feature may be integrating at a time', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      coord.beginIntegration('f-a', graph);

      expect(() => coord.beginIntegration('f-b', graph)).toThrow(
        GraphValidationError,
      );
      expect(graph.features.get('f-b')?.collabControl).toBe('merge_queued');
    });

    it('respects feature dependency legality before allowing enqueue', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b', dependsOn: ['f-a'] });

      // B cannot enqueue while A is unmerged — the coordinator rejects it.
      expect(() => coord.enqueueFeatureMerge('f-b', graph)).toThrow(
        /not merged/,
      );

      // Once A reaches merged, B becomes eligible.
      coord.enqueueFeatureMerge('f-a', graph);
      coord.beginIntegration('f-a', graph);
      coord.completeIntegration('f-a', graph);

      coord.enqueueFeatureMerge('f-b', graph);
      expect(graph.features.get('f-b')?.collabControl).toBe('merge_queued');
    });

    it('stays serialized after dependencies are satisfied', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      // FIFO when no manual position and no re-entries: f-a first.
      expect(coord.nextToIntegrate(graph)).toBe('f-a');

      coord.beginIntegration('f-a', graph);
      expect(graph.features.get('f-b')?.collabControl).toBe('merge_queued');
    });

    it('finishes integration before the next feature begins', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      coord.beginIntegration('f-a', graph);
      coord.completeIntegration('f-a', graph);

      expect(graph.features.get('f-a')?.collabControl).toBe('merged');
      expect(coord.nextToIntegrate(graph)).toBe('f-b');

      coord.beginIntegration('f-b', graph);
      expect(graph.features.get('f-b')?.collabControl).toBe('integrating');
    });
  });

  describe('ejection and repair re-entry', () => {
    it('ejects a queued feature back to branch_open for repair', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.ejectFromQueue('f-a', graph);

      const ejected = graph.features.get('f-a');
      expect(ejected?.collabControl).toBe('branch_open');
      expect(ejected?.workControl).toBe('awaiting_merge');
      expect(ejected?.mergeTrainEntrySeq).toBeUndefined();
      expect(ejected?.mergeTrainEnteredAt).toBeUndefined();
      expect(ejected?.mergeTrainReentryCount).toBe(1);
    });

    it('eviction increments reentry count which biases the next sort', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      // Both enqueue, f-a first.
      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      // f-a fails merge-train verification, gets ejected.
      coord.ejectFromQueue('f-a', graph);

      // Repair lands; f-a re-enters. Its reentry count is 1, so it
      // sorts ahead of f-b even though f-b entered the queue earlier.
      coord.enqueueFeatureMerge('f-a', graph);

      expect(coord.nextToIntegrate(graph)).toBe('f-a');
    });

    it('rebase failure during integration surfaces as a conflict collab state', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.beginIntegration('f-a', graph);

      // Simulate a rebase conflict during integration. The coordinator
      // doesn't drive this transition itself — callers report the failure
      // by transitioning collab to 'conflict'.
      graph.transitionFeature('f-a', { collabControl: 'conflict' });

      expect(graph.features.get('f-a')?.collabControl).toBe('conflict');
      // Feature is no longer in the queue.
      expect(coord.nextToIntegrate(graph)).toBeUndefined();
    });

    it('successful repair returns a conflict feature to the queue', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.beginIntegration('f-a', graph);
      graph.transitionFeature('f-a', { collabControl: 'conflict' });

      // Repair work lands, feature returns to branch_open, then re-enqueues.
      graph.transitionFeature('f-a', { collabControl: 'branch_open' });
      coord.enqueueFeatureMerge('f-a', graph);

      const reEnqueued = graph.features.get('f-a');
      expect(reEnqueued?.collabControl).toBe('merge_queued');
      expect(coord.nextToIntegrate(graph)).toBe('f-a');
    });
  });

  describe('state is persisted', () => {
    it('rehydrates merge-train state from the database', () => {
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.coord.enqueueFeatureMerge('f-a', scenario.graph);
      scenario.coord.beginIntegration('f-a', scenario.graph);

      // Rehydrate a second graph over the same DB to confirm the row
      // state is the source of truth rather than in-memory bookkeeping.
      const rehydrated = new PersistentFeatureGraph(
        scenario.db,
        () => scenario.clock.now,
      );

      const feature = rehydrated.features.get('f-a');
      expect(feature?.collabControl).toBe('integrating');
      expect(feature?.workControl).toBe('awaiting_merge');
      expect(feature?.mergeTrainEntrySeq).toBe(1);
    });
  });
});

describe('merge-train re-entry cap (scheduler integration)', () => {
  function buildCapPorts(reentryCap: number): {
    ports: OrchestratorPorts;
    store: InMemoryStore;
  } {
    const store = new InMemoryStore();
    const config: GvcConfig = {
      ...testGvcConfigDefaults(),
      tokenProfile: 'balanced',
      reentryCap,
    };
    const verification = new VerificationService({ config });
    const ports: OrchestratorPorts = {
      store,
      runtime: {
        dispatchTask: () =>
          Promise.resolve({
            kind: 'started',
            taskId: 't-1',
            agentRunId: 'run-1',
            sessionId: 'sess-1',
          }),
        steerTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
        suspendTask: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        resumeTask: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        respondToHelp: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        decideApproval: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        sendManualInput: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        abortTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
        respondClaim: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        idleWorkerCount: () => 0,
        stopAll: () => Promise.resolve(),
      },
      sessionStore: new InMemorySessionStore(),
      agents: {} as OrchestratorPorts['agents'],
      verification,
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
        removeWorktree: () => Promise.resolve(),
        deleteBranch: () => Promise.resolve(),
        pruneStaleWorktrees: () => Promise.resolve([]),
        sweepStaleLocks: () => Promise.resolve([]),
      },
      ui: {
        show: async () => {},
        refresh: () => {},
        dispose: () => {},
      },
      config,
    };
    return { ports, store };
  }

  it('feature at cap receives inbox item and is not re-enqueued', async () => {
    // reentryCap=2, feature already at reentryCount=1 — one more ejection hits cap
    const { ports, store } = buildCapPorts(2);
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);

    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'Milestone 1',
          description: 'desc',
          status: 'pending',
          order: 0,
        },
      ],
      features: [
        {
          id: 'f-a',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature A',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
          featureBranch: 'feat-feature-a-1',
          mergeTrainEnteredAt: 1000,
          mergeTrainEntrySeq: 1,
          // Already at count 1 — next ejection (→ 2) will hit reentryCap=2
          mergeTrainReentryCount: 1,
        },
      ],
      tasks: [],
    });

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_failed',
      featureId: 'f-a',
      error: 'rebase conflict on main',
    });

    await loop.step(Date.now());

    // Assert inbox row persisted with cap-reached kind
    const inboxItems = store.listInboxItems();
    const capItem = inboxItems.find(
      (item) => item.kind === 'merge_train_cap_reached',
    );
    expect(capItem).toBeDefined();
    expect(capItem?.featureId).toBe('f-a');
    expect(capItem?.payload).toEqual(
      expect.objectContaining({
        reentryCount: 2,
        cap: 2,
      }),
    );

    // Feature should be in conflict collab state (parked, not re-enqueued)
    const parkedFeature = graph.features.get('f-a');
    expect(parkedFeature?.collabControl).toBe('conflict');
    expect(parkedFeature?.mergeTrainReentryCount).toBe(2);

    // No repair agent_runs should have been created
    const repairRuns = store
      .listAgentRuns()
      .filter((run) => run.scopeId === 'f-a');
    expect(repairRuns).toHaveLength(0);

    // No repair tasks created
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-a' && task.repairSource === 'integration',
    );
    expect(repairTasks).toHaveLength(0);
  });
});

describe('integration runner: happy path (scheduler integration)', () => {
  const rebaseGitDirMock = vi.mocked(rebaseGitDir);
  const simpleGitMock = vi.mocked(simpleGit);

  beforeEach(() => {
    vi.clearAllMocks();
    rebaseGitDirMock.mockResolvedValue({ kind: 'clean' });
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    simpleGitMock.mockReturnValue({
      merge: mergeFn,
    } as unknown as ReturnType<typeof simpleGit>);
  });

  it('integration runner: happy path emits feature_integration_complete', async () => {
    const store = new InMemoryStore();
    const config: GvcConfig = {
      ...testGvcConfigDefaults(),
      tokenProfile: 'balanced',
    };
    const verification = new VerificationService({ config });

    const verifyFeatureMock = vi
      .fn<() => Promise<VerificationSummary>>()
      .mockResolvedValue({ ok: true, summary: 'all good' });
    const agentVerifyMock = vi
      .fn<() => Promise<VerificationSummary>>()
      .mockResolvedValue({ ok: true });

    const ports: OrchestratorPorts = {
      store,
      runtime: {
        dispatchTask: () =>
          Promise.resolve({
            kind: 'started',
            taskId: 't-1',
            agentRunId: 'run-1',
            sessionId: 'sess-1',
          }),
        steerTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
        suspendTask: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        resumeTask: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        respondToHelp: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        decideApproval: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        sendManualInput: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        abortTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
        respondClaim: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        idleWorkerCount: () => 0,
        stopAll: () => Promise.resolve(),
      },
      sessionStore: new InMemorySessionStore(),
      agents: {
        verifyFeature: agentVerifyMock,
      } as unknown as OrchestratorPorts['agents'],
      verification: {
        ...verification,
        verifyFeature: verifyFeatureMock,
      } as unknown as OrchestratorPorts['verification'],
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
        removeWorktree: () => Promise.resolve(),
        deleteBranch: () => Promise.resolve(),
        pruneStaleWorktrees: () => Promise.resolve([]),
        sweepStaleLocks: () => Promise.resolve([]),
      },
      ui: {
        show: async () => {},
        refresh: () => {},
        dispose: () => {},
      },
      config,
    };

    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'Milestone 1',
          description: 'desc',
          status: 'pending',
          order: 0,
        },
      ],
      features: [
        {
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
          featureBranch: 'feat-f1-1',
          mergeTrainEnteredAt: 1000,
          mergeTrainEntrySeq: 1,
        },
      ],
      tasks: [],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    // After the full happy-path runner: rebase clean → shell ok → agent ok →
    // fast-forward merge → feature_integration_complete → completeIntegration
    // transitions collabControl to 'merged'.
    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('merged');

    // Shell verification was called once with the integrating feature.
    expect(verifyFeatureMock).toHaveBeenCalledOnce();
    expect(verifyFeatureMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
    );

    // Agent review was called with the correct run-integration: prefix.
    expect(agentVerifyMock).toHaveBeenCalledOnce();
    expect(agentVerifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      expect.objectContaining({ agentRunId: 'run-integration:f-1' }),
    );

    // simpleGit was invoked for the fast-forward merge.
    expect(simpleGitMock).toHaveBeenCalled();
  });
});

// SC3 (main not advanced on verify failure) is covered by the integration-runner
// unit tests in test/unit/orchestrator/integration-runner.test.ts (shell fail →
// feature_integration_failed → no simpleGit merge call). No duplication here.

describe('cross-feature release on primary integration failure (scheduler integration)', () => {
  // Phase 6 SC4 acceptance: two features with cross-feature conflicts handled via
  // conflict coordination protocol, not silent starvation.

  const rebaseGitDirMock = vi.mocked(rebaseGitDir);

  function buildCrossFeaturePorts(reentryCap = 10): {
    ports: OrchestratorPorts;
    store: InMemoryStore;
  } {
    const store = new InMemoryStore();
    const config: GvcConfig = {
      ...testGvcConfigDefaults(),
      tokenProfile: 'balanced',
      reentryCap,
    };
    const verification = new VerificationService({ config });
    const ports: OrchestratorPorts = {
      store,
      runtime: {
        dispatchTask: () =>
          Promise.resolve({
            kind: 'started',
            taskId: 't-1',
            agentRunId: 'run-1',
            sessionId: 'sess-1',
          }),
        steerTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
        suspendTask: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        resumeTask: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        respondToHelp: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        decideApproval: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        sendManualInput: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        abortTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
        respondClaim: (taskId) =>
          Promise.resolve({ kind: 'not_running', taskId }),
        idleWorkerCount: () => 0,
        stopAll: () => Promise.resolve(),
      },
      sessionStore: new InMemorySessionStore(),
      agents: {} as OrchestratorPorts['agents'],
      verification,
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
        removeWorktree: () => Promise.resolve(),
        deleteBranch: () => Promise.resolve(),
        pruneStaleWorktrees: () => Promise.resolve([]),
        sweepStaleLocks: () => Promise.resolve([]),
      },
      ui: {
        show: async () => {},
        refresh: () => {},
        dispose: () => {},
      },
      config,
    };
    return { ports, store };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('primary fails integration — blocked secondary receives integration repair task (SC4)', async () => {
    // Scenario: f-1 is integrating. f-2 is blocked by f-1 with a suspended task.
    // The integration runner rebases f-1 onto main and hits a conflict →
    // emits feature_integration_failed. The handler then calls
    // releaseCrossFeatureOverlap(f-1), which rebases f-2 onto main — also
    // conflict — so f-2 gets a createIntegrationRepair call.
    //
    // Assertions verify SC4: f-2 is NOT silently stranded; it receives a repair task.

    const { ports, store } = buildCrossFeaturePorts(10);
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);

    // f-1 rebase onto main: conflict → integration runner emits feature_integration_failed
    // f-2 rebase onto main: conflict → releaseCrossFeatureOverlap returns repair_needed
    rebaseGitDirMock
      .mockResolvedValueOnce({
        kind: 'conflict',
        conflictedFiles: ['shared.ts'],
      })
      .mockResolvedValueOnce({
        kind: 'conflict',
        conflictedFiles: ['shared.ts'],
      });

    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'Milestone 1',
          description: 'desc',
          status: 'pending',
          order: 0,
        },
      ],
      features: [
        {
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
          featureBranch: 'feat-f1-1',
          mergeTrainEnteredAt: 1000,
          mergeTrainEntrySeq: 1,
          mergeTrainReentryCount: 0,
        },
        {
          id: 'f-2',
          milestoneId: 'm-1',
          orderInMilestone: 1,
          name: 'Feature 2',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
          featureBranch: 'feat-f2-1',
          runtimeBlockedByFeatureId: 'f-1',
        },
      ],
      tasks: [
        {
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          description: 'Task 2',
          dependsOn: [],
          status: 'running',
          collabControl: 'suspended',
          blockedByFeatureId: 'f-1',
          suspendReason: 'cross_feature_overlap',
          suspendedAt: 900,
        },
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    // f-1: failed integration → conflict/executing_repair, reentryCount incremented
    expect(graph.features.get('f-1')).toMatchObject({
      collabControl: 'conflict',
      workControl: 'executing_repair',
      mergeTrainReentryCount: 1,
    });
    const f1RepairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-1' && task.repairSource === 'integration',
    );
    expect(f1RepairTasks).toHaveLength(1);

    // f-2: blocked secondary released via repair — NOT silently stranded (SC4)
    expect(graph.features.get('f-2')).toMatchObject({
      collabControl: 'conflict',
      workControl: 'executing_repair',
    });
    const f2RepairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(f2RepairTasks).toHaveLength(1);
    expect(f2RepairTasks[0]?.description).toContain('shared.ts');

    // main was NOT advanced — simpleGit was not called (no fast-forward merge)
    expect(vi.mocked(simpleGit)).not.toHaveBeenCalled();

    // No inbox items for f-2 (it gets a repair task, not parked)
    const f2InboxItems = store
      .listInboxItems()
      .filter((item) => item.featureId === 'f-2');
    expect(f2InboxItems).toHaveLength(0);

    // Verify no inbox item for cap (reentryCount=1 < reentryCap=10)
    const capItems = store
      .listInboxItems()
      .filter((item) => item.kind === 'merge_train_cap_reached');
    expect(capItems).toHaveLength(0);
  });

  it('SC2 acceptance: feature at re-entry cap receives inbox item, secondary also gets repair', async () => {
    // f-1 at mergeTrainReentryCount=9, reentryCap=10. After integration failure
    // the count becomes 10 = cap → inbox item emitted, no repair task for f-1.
    // f-2 is blocked by f-1; it should still receive a repair task (cross-feature
    // release runs regardless of whether the primary hit the cap).

    const { ports, store } = buildCrossFeaturePorts(10);
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);

    // f-1 rebase onto main: conflict (triggers feature_integration_failed)
    // f-2 rebase onto main: conflict (triggers repair_needed in releaseCrossFeatureOverlap)
    rebaseGitDirMock
      .mockResolvedValueOnce({
        kind: 'conflict',
        conflictedFiles: ['shared.ts'],
      })
      .mockResolvedValueOnce({
        kind: 'conflict',
        conflictedFiles: ['shared.ts'],
      });

    const graph = new InMemoryFeatureGraph({
      milestones: [
        {
          id: 'm-1',
          name: 'Milestone 1',
          description: 'desc',
          status: 'pending',
          order: 0,
        },
      ],
      features: [
        {
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
          featureBranch: 'feat-f1-1',
          mergeTrainEnteredAt: 1000,
          mergeTrainEntrySeq: 1,
          // At count 9: next ejection → 10 = cap
          mergeTrainReentryCount: 9,
        },
        {
          id: 'f-2',
          milestoneId: 'm-1',
          orderInMilestone: 1,
          name: 'Feature 2',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
          featureBranch: 'feat-f2-1',
          runtimeBlockedByFeatureId: 'f-1',
        },
      ],
      tasks: [
        {
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          description: 'Task 2',
          dependsOn: [],
          status: 'running',
          collabControl: 'suspended',
          blockedByFeatureId: 'f-1',
          suspendReason: 'cross_feature_overlap',
          suspendedAt: 900,
        },
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(Date.now());

    // SC2: inbox item with merge_train_cap_reached for f-1
    const capItems = store
      .listInboxItems()
      .filter((item) => item.kind === 'merge_train_cap_reached');
    expect(capItems).toHaveLength(1);
    expect(capItems[0]?.featureId).toBe('f-1');
    expect(capItems[0]?.payload).toEqual(
      expect.objectContaining({ reentryCount: 10, cap: 10 }),
    );

    // f-1 parked (conflict, no repair task)
    expect(graph.features.get('f-1')).toMatchObject({
      collabControl: 'conflict',
      mergeTrainReentryCount: 10,
    });
    const f1RepairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-1' && task.repairSource === 'integration',
    );
    expect(f1RepairTasks).toHaveLength(0);

    // f-2 (secondary) still gets a repair task — not silently stranded
    const f2RepairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(f2RepairTasks).toHaveLength(1);
  });
});
