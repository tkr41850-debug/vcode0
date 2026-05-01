import { InMemoryFeatureGraph } from '@core/graph/index';
import type { Feature, VerificationSummary } from '@core/types/index';
import { rebaseGitDir } from '@orchestrator/conflicts/git.js';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import type { SchedulerEvent } from '@orchestrator/scheduler/index';
import { runIntegrationIfPending } from '@orchestrator/scheduler/integration-runner.js';
import { VerificationService } from '@orchestrator/services/index';
import { simpleGit } from 'simple-git';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

// Module-level mocks: hoisted by Vitest before any imports resolve.
// These are isolated to this file so they don't interfere with real-git
// tests in scheduler-loop.test.ts.
vi.mock('../../../src/orchestrator/conflicts/git.js', () => ({
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

const rebaseGitDirMock = vi.mocked(rebaseGitDir);
const simpleGitMock = vi.mocked(simpleGit);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIntegratingGraph(
  featureOverrides: Partial<Feature> = {},
): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        name: 'Feature 1',
        workControl: 'awaiting_merge',
        collabControl: 'integrating',
        featureBranch: 'feat-feature-1-f-1',
        ...featureOverrides,
      }),
    ],
    tasks: [],
  });
}

function createStoreMock() {
  return {
    getAgentRun: () => undefined,
    listAgentRuns: () => [],
    createAgentRun: () => {},
    updateAgentRun: () => {},
    listEvents: () => [],
    appendEvent: () => {},
    graph: () => {
      throw new Error('not implemented');
    },
    snapshotGraph: () => ({ milestones: [], features: [], tasks: [] }),
    rehydrate: () => ({
      graph: { milestones: [], features: [], tasks: [] },
      openRuns: [],
      pendingEvents: [],
    }),
    appendQuarantinedFrame: () => {},
    setWorkerPid: () => {},
    clearWorkerPid: () => {},
    getLiveWorkerPids: () => [],
    appendInboxItem: () => {},
    listInboxItems: () => [],
    resolveInboxItem: () => {},
    setLastCommitSha: () => {},
    setTrailerObservedAt: () => {},
    getTrailerObservedAt: () => undefined,
    close: () => {},
  } satisfies OrchestratorPorts['store'];
}

function makePorts(
  verifyFeatureResult: VerificationSummary = { ok: true },
  agentVerifyResult: VerificationSummary = { ok: true },
): OrchestratorPorts {
  const config = {
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced' as const,
  };
  const verification = new VerificationService({ config });
  vi.spyOn(verification, 'verifyFeature').mockResolvedValue(
    verifyFeatureResult,
  );

  const agentVerify = vi
    .fn<() => Promise<VerificationSummary>>()
    .mockResolvedValue(agentVerifyResult);

  return {
    store: createStoreMock(),
    runtime: {
      dispatchTask: () =>
        Promise.resolve({
          kind: 'started',
          taskId: 't-1',
          agentRunId: 'r',
          sessionId: 's',
        }),
      steerTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
      suspendTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
      resumeTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
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
      verifyFeature: agentVerify,
    } as unknown as OrchestratorPorts['agents'],
    verification,
    worktree: {
      ensureFeatureWorktree: () => Promise.resolve('/repo'),
      ensureTaskWorktree: () => Promise.resolve('/repo'),
      removeWorktree: () => Promise.resolve(),
      deleteBranch: () => Promise.resolve(),
      pruneStaleWorktrees: () => Promise.resolve([]),
      sweepStaleLocks: () => Promise.resolve([]),
    },
    ui: { show: async () => {}, refresh: () => {}, dispose: () => {} },
    config,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('integration runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: rebase clean; tests override as needed.
    rebaseGitDirMock.mockResolvedValue({ kind: 'clean' });
    // Default simpleGit merge stub (success).
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    simpleGitMock.mockReturnValue({
      merge: mergeFn,
    } as unknown as ReturnType<typeof simpleGit>);
  });

  it('returns immediately when no feature is integrating', async () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          collabControl: 'merge_queued',
          workControl: 'awaiting_merge',
        }),
      ],
      tasks: [],
    });
    const ports = makePorts();
    const handleEvent = vi
      .fn<(e: SchedulerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);

    await runIntegrationIfPending({
      graph,
      ports,
      handleEvent,
      now: 1000,
      cwd: '/fake',
    });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(rebaseGitDirMock).not.toHaveBeenCalled();
  });

  it('emits feature_integration_failed when worktree is missing (blocked rebase)', async () => {
    rebaseGitDirMock.mockResolvedValue({ kind: 'blocked' });

    const graph = makeIntegratingGraph();
    const ports = makePorts();
    const handleEvent = vi
      .fn<(e: SchedulerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);

    await runIntegrationIfPending({
      graph,
      ports,
      handleEvent,
      now: 1000,
      cwd: '/fake',
    });

    expect(handleEvent).toHaveBeenCalledOnce();
    expect(handleEvent).toHaveBeenCalledWith({
      type: 'feature_integration_failed',
      featureId: 'f-1',
      error: 'worktree missing during integration rebase',
    });
  });

  it('emits feature_integration_failed with conflicted file list on rebase conflict', async () => {
    rebaseGitDirMock.mockResolvedValue({
      kind: 'conflict',
      conflictedFiles: ['a.ts', 'b.ts'],
    });

    const graph = makeIntegratingGraph();
    const ports = makePorts();
    const handleEvent = vi
      .fn<(e: SchedulerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);

    await runIntegrationIfPending({
      graph,
      ports,
      handleEvent,
      now: 1000,
      cwd: '/fake',
    });

    expect(handleEvent).toHaveBeenCalledOnce();
    const event = handleEvent.mock.calls[0]?.[0];
    expect(event?.type).toBe('feature_integration_failed');
    if (event?.type === 'feature_integration_failed') {
      expect(event.featureId).toBe('f-1');
      expect(event.error).toContain('a.ts, b.ts');
    }
  });

  it('emits feature_integration_failed when shell verification fails', async () => {
    // rebaseGitDir defaults to { kind: 'clean' } (set in beforeEach).
    const graph = makeIntegratingGraph();
    const ports = makePorts(
      { ok: false, summary: 'lint failed' },
      { ok: true },
    );
    const handleEvent = vi
      .fn<(e: SchedulerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);

    await runIntegrationIfPending({
      graph,
      ports,
      handleEvent,
      now: 1000,
      cwd: '/fake',
    });

    expect(handleEvent).toHaveBeenCalledOnce();
    expect(handleEvent).toHaveBeenCalledWith({
      type: 'feature_integration_failed',
      featureId: 'f-1',
      error: 'lint failed',
    });
  });

  it('emits feature_integration_failed when agent review fails; run ID uses run-integration: prefix', async () => {
    const graph = makeIntegratingGraph();
    const ports = makePorts(
      { ok: true },
      { ok: false, summary: 'agent said no' },
    );
    const agentVerify = vi.spyOn(ports.agents, 'verifyFeature');
    const handleEvent = vi
      .fn<(e: SchedulerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);

    await runIntegrationIfPending({
      graph,
      ports,
      handleEvent,
      now: 1000,
      cwd: '/fake',
    });

    expect(handleEvent).toHaveBeenCalledOnce();
    expect(handleEvent).toHaveBeenCalledWith({
      type: 'feature_integration_failed',
      featureId: 'f-1',
      error: 'agent said no',
    });
    // Confirm run ID uses 'run-integration:' prefix — NOT 'run-feature:'
    expect(agentVerify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      expect.objectContaining({ agentRunId: 'run-integration:f-1' }),
    );
  });

  it('emits feature_integration_complete after all checks pass and fast-forward merge succeeds', async () => {
    const graph = makeIntegratingGraph();
    const ports = makePorts({ ok: true }, { ok: true });
    const handleEvent = vi
      .fn<(e: SchedulerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);

    await runIntegrationIfPending({
      graph,
      ports,
      handleEvent,
      now: 1000,
      cwd: '/fake',
    });

    expect(handleEvent).toHaveBeenCalledOnce();
    expect(handleEvent).toHaveBeenCalledWith({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });
    // simpleGit must be called with the injected cwd, not process.cwd().
    expect(simpleGitMock).toHaveBeenCalledWith('/fake');
  });
});
