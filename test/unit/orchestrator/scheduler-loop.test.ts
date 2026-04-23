import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PlannerAgent, ReplannerAgent } from '@agents/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { GraphProposal } from '@core/proposals/index';
import { deriveSummaryAvailability } from '@core/state';
import type {
  AgentRun,
  AgentRunPhase,
  DiscussPhaseDetails,
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  FeaturePhaseRunContext,
  GvcConfig,
  ProposalPhaseDetails,
  ResearchPhaseDetails,
  SummarizePhaseDetails,
  Task,
  TaskAgentRun,
  VerificationSummary,
} from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  OrchestratorPorts,
  Store,
  UiPort,
} from '@orchestrator/ports/index';
import {
  type SchedulerEvent,
  SchedulerLoop,
} from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import type { RuntimePort, RuntimeUsageDelta } from '@runtime/contracts';
import { runtimeUsageToTokenUsageAggregate } from '@runtime/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

class RecordingSchedulerLoop extends SchedulerLoop {
  readonly handledEvents: SchedulerEvent[] = [];
  readonly dispatchTimes: number[] = [];

  constructor(
    graph: InMemoryFeatureGraph,
    ports: OrchestratorPorts,
    private readonly order: string[],
  ) {
    super(graph, ports);
  }

  protected override handleEvent(event: SchedulerEvent): Promise<void> {
    this.handledEvents.push(event);
    this.order.push(`event:${event.type}`);
    return Promise.resolve();
  }

  protected override dispatchReadyWork(now: number): Promise<void> {
    this.dispatchTimes.push(now);
    this.order.push('dispatch');
    return Promise.resolve();
  }
}

class ObservingSchedulerLoop extends SchedulerLoop {
  readonly handledEvents: SchedulerEvent[] = [];

  protected override async handleEvent(event: SchedulerEvent): Promise<void> {
    this.handledEvents.push(event);
    await super.handleEvent(event);
  }
}

function createStoreMock(): Store {
  const runs = new Map<string, AgentRun>();
  const events: EventRecord[] = [];

  return {
    getAgentRun: (id: string) => runs.get(id),
    listAgentRuns: (query?: AgentRunQuery) => {
      return [...runs.values()].filter((run) => {
        if (
          query?.scopeType !== undefined &&
          run.scopeType !== query.scopeType
        ) {
          return false;
        }
        if (query?.scopeId !== undefined && run.scopeId !== query.scopeId) {
          return false;
        }
        if (query?.phase !== undefined && run.phase !== query.phase) {
          return false;
        }
        if (
          query?.runStatus !== undefined &&
          run.runStatus !== query.runStatus
        ) {
          return false;
        }
        if (query?.owner !== undefined && run.owner !== query.owner) {
          return false;
        }
        return true;
      });
    },
    createAgentRun: (run: AgentRun) => {
      runs.set(run.id, run);
    },
    updateAgentRun: (runId: string, patch: AgentRunPatch) => {
      const existing = runs.get(runId);
      if (existing === undefined) {
        throw new Error(`agent run "${runId}" does not exist`);
      }
      runs.set(runId, { ...existing, ...patch } as AgentRun);
    },
    listEvents: (query?: EventQuery) => {
      return events.filter((event) => {
        if (
          query?.eventType !== undefined &&
          event.eventType !== query.eventType
        ) {
          return false;
        }
        if (
          query?.entityId !== undefined &&
          event.entityId !== query.entityId
        ) {
          return false;
        }
        if (query?.since !== undefined && event.timestamp < query.since) {
          return false;
        }
        if (query?.until !== undefined && event.timestamp > query.until) {
          return false;
        }
        return true;
      });
    },
    appendEvent: (event: EventRecord) => {
      events.push(event);
    },
  };
}

function createRuntimeMock(order: string[]): RuntimePort & {
  stopAll: ReturnType<typeof vi.fn>;
} {
  return {
    dispatchTask: (_task: Task, _dispatch) =>
      Promise.resolve({
        kind: 'started',
        taskId: 't-1',
        agentRunId: 'run-1',
        sessionId: 'sess-1',
      }),
    steerTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    suspendTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    resumeTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    respondToHelp: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    decideApproval: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    sendManualInput: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    abortTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    idleWorkerCount: () => 4,
    stopAll: vi.fn(() => {
      order.push('stopAll');
      return Promise.resolve();
    }),
  };
}

function makeProposal(mode: 'plan' | 'replan' = 'plan'): GraphProposal {
  return {
    version: 1,
    mode,
    aliases: {
      '#1': 't-1',
      '#2': 't-2',
    },
    ops: [
      {
        kind: 'add_task',
        taskId: 't-1',
        featureId: 'f-1',
        description: 'Draft task 1',
      },
      {
        kind: 'add_task',
        taskId: 't-2',
        featureId: 'f-1',
        description: 'Draft task 2',
      },
      {
        kind: 'add_dependency',
        fromId: 't-2',
        toId: 't-1',
      },
    ],
  };
}

const proposalDetails: ProposalPhaseDetails = {
  summary: 'ok',
  chosenApproach: 'Use existing proposal graph flow.',
  keyConstraints: ['Keep raw proposal in payloadJson'],
  decompositionRationale: ['Change contracts before downstream prompts'],
  orderingRationale: ['Fix reruns before relying on replan'],
  verificationExpectations: ['Run scheduler and runtime tests'],
  risksTradeoffs: ['More structured events widen assertions'],
  assumptions: ['Approval still parses raw proposal'],
};

function createAgentMock(): PlannerAgent & ReplannerAgent {
  const discussResult = {
    summary: 'ok',
    extra: {
      intent: 'intent',
      successCriteria: ['criterion'],
      constraints: [],
      risks: [],
      externalIntegrations: [],
      antiGoals: [],
      openQuestions: [],
    } satisfies DiscussPhaseDetails,
  };
  const researchResult = {
    summary: 'ok',
    extra: {
      existingBehavior: 'existing',
      essentialFiles: [],
      reusePatterns: [],
      riskyBoundaries: [],
      proofsNeeded: [],
      verificationSurfaces: [],
      planningNotes: [],
    } satisfies ResearchPhaseDetails,
  };
  const summarizeResult = {
    summary: 'ok',
    extra: {
      outcome: 'outcome',
      deliveredCapabilities: [],
      importantFiles: [],
      verificationConfidence: [],
      carryForwardNotes: [],
    } satisfies SummarizePhaseDetails,
  };
  const verificationResult: VerificationSummary = { ok: true };

  return {
    discussFeature: (_feature: Feature, _run: FeaturePhaseRunContext) =>
      Promise.resolve(discussResult),
    researchFeature: (_feature: Feature, _run: FeaturePhaseRunContext) =>
      Promise.resolve(researchResult),
    planFeature: (_feature: Feature, _run: FeaturePhaseRunContext) =>
      Promise.resolve({
        summary: 'ok',
        proposal: makeProposal('plan'),
        details: proposalDetails,
      }),
    verifyFeature: (_feature: Feature, _run: FeaturePhaseRunContext) =>
      Promise.resolve(verificationResult),
    summarizeFeature: (_feature: Feature, _run: FeaturePhaseRunContext) =>
      Promise.resolve(summarizeResult),
    replanFeature: (
      _feature: Feature,
      _reason: string,
      _run: FeaturePhaseRunContext,
    ) =>
      Promise.resolve({
        summary: 'ok',
        proposal: makeProposal('replan'),
        details: { ...proposalDetails, summary: 'ok' },
      }),
  };
}

function createUiMock(order: string[]): UiPort & {
  refresh: ReturnType<typeof vi.fn>;
} {
  return {
    show: async () => {},
    refresh: vi.fn(() => {
      order.push('refresh');
    }),
    dispose: () => {},
  };
}

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createPorts(
  order: string[],
  configOverrides: Partial<GvcConfig> = {},
): {
  ports: OrchestratorPorts;
  runtime: RuntimePort & { stopAll: ReturnType<typeof vi.fn> };
  ui: UiPort & { refresh: ReturnType<typeof vi.fn> };
} {
  const runtime = createRuntimeMock(order);
  const ui = createUiMock(order);

  const base = {
    store: createStoreMock(),
    runtime,
    sessionStore: new InMemorySessionStore(),
    agents: createAgentMock() as unknown as OrchestratorPorts['agents'],
    ui,
    config: createConfig(configOverrides),
  };
  const verification = new VerificationService({ config: base.config });

  return {
    ports: {
      ...base,
      verification,
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
      },
    },
    runtime,
    ui,
  };
}

function createEvents(): SchedulerEvent[] {
  return [
    {
      type: 'worker_message',
      message: {
        type: 'progress',
        taskId: 't-1',
        agentRunId: 'run-1',
        message: 'still working',
      },
    },
    {
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'plan',
      summary: 'planned',
    },
    {
      type: 'feature_phase_error',
      featureId: 'f-1',
      phase: 'verify',
      error: 'boom',
    },
    {
      type: 'shutdown',
    },
  ];
}

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-task-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeFeaturePhaseRun(
  phase: AgentRunPhase,
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: `run-feature:f-1:${phase}`,
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase,
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function createSchedulerGraph(
  input?: ConstructorParameters<typeof InMemoryFeatureGraph>[0],
): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: input?.milestones ?? [createMilestoneFixture()],
    features: input?.features ?? [],
    tasks: input?.tasks ?? [],
  });
}

function createSingleFeatureGraph(
  featureOverrides: Partial<Feature> = {},
  tasks: Task[] = [],
): InMemoryFeatureGraph {
  return createSchedulerGraph({
    milestones: [createMilestoneFixture()],
    features: [createFeatureFixture(featureOverrides)],
    tasks,
  });
}

function createSingleTaskDispatchGraph(
  overrides: { feature?: Partial<Feature>; task?: Partial<Task> } = {},
): InMemoryFeatureGraph {
  return createSingleFeatureGraph(
    {
      status: 'pending',
      workControl: 'executing',
      collabControl: 'none',
      ...overrides.feature,
    },
    [
      createTaskFixture({
        id: 't-1',
        description: 'Task 1',
        status: 'ready',
        collabControl: 'none',
        ...overrides.task,
      }),
    ],
  );
}

function createProposalApprovalGraph(
  featureOverrides: Partial<Feature> = {},
  tasks: Task[] = [],
): InMemoryFeatureGraph {
  return createSingleFeatureGraph(
    {
      status: 'in_progress',
      workControl: 'planning',
      collabControl: 'none',
      ...featureOverrides,
    },
    tasks,
  );
}

async function git(dir: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error('git command failed'),
        );
        return;
      }
      resolve();
    });
  });
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'base\n');
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Test User');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'add', 'README.md', '.gitignore');
  await git(dir, 'commit', '-m', 'init');
}

async function writeFeatureRebaseRepo(
  root: string,
  feature: Feature,
): Promise<string> {
  const featureDir = path.join(root, worktreePath(feature.featureBranch));
  await initRepo(featureDir);
  await fs.mkdir(path.join(featureDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'base\n');
  await git(featureDir, 'add', 'src/a.ts');
  await git(featureDir, 'commit', '-m', 'shared base');
  await git(featureDir, 'checkout', '-b', feature.featureBranch);
  return featureDir;
}

const getTmpDir = useTmpDir('scheduler-loop');
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  process.chdir(getTmpDir());
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.useRealTimers();
});

describe('SchedulerLoop', () => {
  it('stores typed events until the next scheduler tick', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      createSchedulerGraph(),
      ports,
      order,
    );
    const events = createEvents();

    for (const event of events) {
      loop.enqueue(event);
    }

    await loop.run();

    await vi.advanceTimersByTimeAsync(999);
    expect(loop.handledEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(loop.handledEvents).toEqual(events);

    await loop.stop();
  });

  it('drains queued events serially before dispatching ready work', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      createSchedulerGraph(),
      ports,
      order,
    );

    loop.enqueue({ type: 'shutdown' });
    loop.enqueue({
      type: 'feature_phase_error',
      featureId: 'f-1',
      phase: 'research',
      error: 'nope',
    });

    await loop.run();
    await vi.advanceTimersByTimeAsync(1000);

    expect(order).toEqual([
      'event:shutdown',
      'event:feature_phase_error',
      'dispatch',
    ]);

    await loop.stop();
  });

  it('runs on a 1-second interval without refreshing UI when no state changed', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports, ui } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      createSchedulerGraph(),
      ports,
      order,
    );

    await loop.run();

    expect(ui.refresh).not.toHaveBeenCalled();
    expect(loop.dispatchTimes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.refresh).not.toHaveBeenCalled();
    expect(loop.dispatchTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.refresh).not.toHaveBeenCalled();
    expect(loop.dispatchTimes).toHaveLength(2);

    await loop.stop();
  });

  it('stops the interval and stops all runtime work', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      createSchedulerGraph(),
      ports,
      order,
    );

    await loop.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(loop.dispatchTimes).toHaveLength(1);

    await loop.stop();
    expect(runtime.stopAll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(loop.dispatchTimes).toHaveLength(1);
  });

  it('does not start a new tick while the previous tick is still in flight', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports } = createPorts(order);

    let concurrent = 0;
    let maxConcurrent = 0;
    let firstTickStarted = false;

    class SlowFirstTickLoop extends SchedulerLoop {
      protected override async tick(_now: number): Promise<void> {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        if (!firstTickStarted) {
          firstTickStarted = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        }
        concurrent--;
      }
    }

    const loop = new SlowFirstTickLoop(createSchedulerGraph(), ports);
    await loop.run();
    await vi.advanceTimersByTimeAsync(2500);

    expect(maxConcurrent).toBe(1);

    await vi.advanceTimersByTimeAsync(10000);
    await loop.stop();
  });

  it('keeps looping after a tick throws', async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const order: string[] = [];
    const { ports } = createPorts(order);

    let tickCount = 0;
    class FlakyTickLoop extends SchedulerLoop {
      protected override async tick(_now: number): Promise<void> {
        tickCount++;
        if (tickCount === 1) {
          throw new Error('boom');
        }
      }
    }

    const loop = new FlakyTickLoop(createSchedulerGraph(), ports);
    await loop.run();
    await vi.advanceTimersByTimeAsync(3000);

    expect(tickCount).toBeGreaterThanOrEqual(2);
    expect(consoleError).toHaveBeenCalled();

    await loop.stop();
    consoleError.mockRestore();
  });

  it('creates a missing task run on first dispatch and starts it', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const graph = createSingleTaskDispatchGraph();
    const createAgentRun = vi.spyOn(ports.store, 'createAgentRun');
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(createAgentRun).toHaveBeenCalledTimes(1);
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-task:t-1',
        scopeType: 'task',
        scopeId: 't-1',
        phase: 'execute',
        runStatus: 'ready',
        owner: 'system',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
      }),
    );
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      { mode: 'start', agentRunId: 'run-task:t-1' },
      expect.any(Object),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'system',
      sessionId: 'sess-1',
      restartCount: 0,
    });
  });

  it('skips dispatch when auto execution is disabled', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const graph = createSingleTaskDispatchGraph();
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');
    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    await loop.step(100);

    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('resumes an existing task run when session state is present', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const graph = createSingleTaskDispatchGraph();
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-existing',
      }),
    );
    const createAgentRun = vi.spyOn(ports.store, 'createAgentRun');
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(createAgentRun).not.toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: 'run-task:t-1',
        sessionId: 'sess-existing',
      },
      expect.any(Object),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'system',
      sessionId: 'sess-1',
      restartCount: 0,
    });
  });

  it('falls back to a fresh start when a stored session is not resumable', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const graph = createSingleTaskDispatchGraph();
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-existing',
        restartCount: 2,
      }),
    );
    const dispatchTask = vi
      .spyOn(runtime, 'dispatchTask')
      .mockResolvedValueOnce({
        kind: 'not_resumable',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        sessionId: 'sess-existing',
        reason: 'session_not_found',
      })
      .mockResolvedValueOnce({
        kind: 'started',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        sessionId: 'sess-fresh',
      });
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(dispatchTask).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      {
        mode: 'resume',
        agentRunId: 'run-task:t-1',
        sessionId: 'sess-existing',
      },
      expect.any(Object),
    );
    expect(dispatchTask).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        mode: 'start',
        agentRunId: 'run-task:t-1',
      },
      expect.any(Object),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'system',
      sessionId: 'sess-fresh',
      restartCount: 2,
    });
  });

  it('increments restartCount when a retry-eligible run is actually redispatched', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const graph = createSingleTaskDispatchGraph();
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'retry_await',
        retryAt: 100,
        restartCount: 2,
      }),
    );
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      { mode: 'start', agentRunId: 'run-task:t-1' },
      expect.any(Object),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'system',
      sessionId: 'sess-1',
      restartCount: 3,
    });
  });

  it('dispatches only up to idle worker capacity', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const idleWorkerCount = vi
      .spyOn(runtime, 'idleWorkerCount')
      .mockReturnValue(1);
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'ready',
          collabControl: 'none',
        }),
        createTaskFixture({
          id: 't-2',
          orderInFeature: 1,
          description: 'Task 2',
          status: 'ready',
          collabControl: 'none',
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(idleWorkerCount).toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      { mode: 'start', agentRunId: 'run-task:t-1' },
      expect.any(Object),
    );
  });

  it('completes a task run, marks the task merged, and advances the feature to ci_check after the last task lands', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        result: {
          summary: 'done',
          filesChanged: ['src/a.ts'],
        },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });
    await loop.step(100);

    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'done',
        collabControl: 'merged',
        result: {
          summary: 'done',
          filesChanged: ['src/a.ts'],
        },
      }),
    );
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'ci_check',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'completed',
      owner: 'system',
      sessionId: 'sess-1',
      tokenUsage: runtimeUsageToTokenUsageAggregate({
        provider: 'test',
        model: 'fake',
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        usd: 0,
      }),
    });
  });

  it('persists token usage from worker result message onto the task agent run', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);
    const usage: RuntimeUsageDelta = {
      provider: 'test',
      model: 'fake',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      usd: 0.5,
    };

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        result: { summary: 'done', filesChanged: [] },
        usage,
        completionKind: 'submitted',
      },
    });
    await loop.step(100);

    const run = ports.store.getAgentRun('run-task:t-1');
    expect(run?.tokenUsage).toEqual(runtimeUsageToTokenUsageAggregate(usage));
  });

  it('persists token usage from worker error message onto the task agent run', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
        restartCount: 1,
      }),
    );

    const loop = new SchedulerLoop(graph, ports);
    const usage: RuntimeUsageDelta = {
      provider: 'test',
      model: 'fake',
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
      usd: 0.25,
    };

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'error',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        error: 'transient',
        usage,
      },
    });
    await loop.step(100);

    const run = ports.store.getAgentRun('run-task:t-1');
    expect(run?.tokenUsage).toEqual(runtimeUsageToTokenUsageAggregate(usage));
  });

  it('suspends lower-priority running tasks when same-feature runtime overlap appears', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          orderInFeature: 1,
          description: 'Task 2',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.tasks.get('t-1')).toMatchObject({
      status: 'running',
      collabControl: 'branch_open',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      status: 'running',
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(suspendTask).toHaveBeenCalledTimes(1);
    expect(suspendTask).toHaveBeenCalledWith('t-2', 'same_feature_overlap', [
      'src/a.ts',
    ]);
  });

  it('suspends only overlapping component inside same feature', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          orderInFeature: 1,
          description: 'Task 2',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-3',
          orderInFeature: 2,
          description: 'Task 3',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/b.ts'],
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.tasks.get('t-1')).toMatchObject({
      collabControl: 'branch_open',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-3')).toMatchObject({
      collabControl: 'branch_open',
    });
    expect(suspendTask).toHaveBeenCalledTimes(1);
    expect(suspendTask).toHaveBeenCalledWith('t-2', 'same_feature_overlap', [
      'src/a.ts',
    ]);
  });

  it('normalizes reserved write paths before same-feature overlap grouping', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['./src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          orderInFeature: 1,
          description: 'Task 2',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/./a.ts'],
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.tasks.get('t-1')).toMatchObject({
      collabControl: 'branch_open',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'same_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(suspendTask).toHaveBeenCalledTimes(1);
    expect(suspendTask).toHaveBeenCalledWith('t-2', 'same_feature_overlap', [
      'src/a.ts',
    ]);
  });

  it('persists per-task overlap files for chained same-feature overlaps', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          orderInFeature: 1,
          description: 'Task 2',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts', 'src/b.ts'],
        }),
        createTaskFixture({
          id: 't-3',
          orderInFeature: 2,
          description: 'Task 3',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/b.ts'],
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'suspended',
      suspendedFiles: ['src/a.ts', 'src/b.ts'],
    });
    expect(graph.tasks.get('t-3')).toMatchObject({
      collabControl: 'suspended',
      suspendedFiles: ['src/b.ts'],
    });
    expect(suspendTask).toHaveBeenCalledTimes(2);
    expect(suspendTask).toHaveBeenNthCalledWith(
      1,
      't-2',
      'same_feature_overlap',
      ['src/a.ts', 'src/b.ts'],
    );
    expect(suspendTask).toHaveBeenNthCalledWith(
      2,
      't-3',
      'same_feature_overlap',
      ['src/b.ts'],
    );
  });

  it('does not treat implicit worker exit as a landed task', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        result: {
          summary: 'assistant stopped',
          filesChanged: [],
        },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          usd: 0,
        },
        completionKind: 'implicit',
      },
    });
    await loop.step(100);

    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'done',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
    );
  });

  it('puts a transient worker error into retry_await and returns the task to ready', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
        restartCount: 1,
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'error',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        error: 'provider overloaded',
      },
    });
    await loop.step(100);

    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'ready',
        collabControl: 'branch_open',
      }),
    );
    const retryTaskRunPatch = updateAgentRun.mock.calls.find(
      ([runId, patch]) =>
        runId === 'run-task:t-1' && patch.runStatus === 'retry_await',
    )?.[1];
    expect(updateAgentRun).toHaveBeenCalledWith(
      'run-task:t-1',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
      }),
    );
    expect(retryTaskRunPatch?.retryAt).toEqual(expect.any(Number));
  });

  it('ignores late worker result for cancelled task runs', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'cancelled',
          collabControl: 'suspended',
          suspendReason: 'cross_feature_overlap',
          blockedByFeatureId: 'f-2',
          suspendedAt: 100,
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'cancelled',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        result: {
          summary: 'done',
          filesChanged: ['src/a.ts'],
        },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });
    await loop.step(100);

    expect(graph.tasks.get('t-1')).toMatchObject({
      status: 'cancelled',
      collabControl: 'suspended',
      blockedByFeatureId: 'f-2',
    });
    expect(updateAgentRun).not.toHaveBeenCalledWith(
      'run-task:t-1',
      expect.objectContaining({ runStatus: 'completed' }),
    );
  });

  it('ignores late worker error for cancelled task runs', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'cancelled',
          collabControl: 'suspended',
          suspendReason: 'cross_feature_overlap',
          blockedByFeatureId: 'f-2',
          suspendedAt: 100,
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'cancelled',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'error',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        error: 'provider overloaded',
      },
    });
    await loop.step(100);

    expect(graph.tasks.get('t-1')).toMatchObject({
      status: 'cancelled',
      collabControl: 'suspended',
      blockedByFeatureId: 'f-2',
    });
    expect(updateAgentRun).not.toHaveBeenCalledWith(
      'run-task:t-1',
      expect.objectContaining({ runStatus: 'retry_await' }),
    );
  });

  it('moves a task run to await_response manual ownership on request_help', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'request_help',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        query: 'what should I do?',
      },
    });
    await loop.step(100);

    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'await_response',
      owner: 'manual',
      payloadJson: JSON.stringify({ query: 'what should I do?' }),
      sessionId: 'sess-1',
    });
  });

  it('moves a task run to await_approval on request_approval', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'executing',
        collabControl: 'none',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'request_approval',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        payload: {
          kind: 'custom',
          label: 'Need approval',
          detail: 'delete file',
        },
      },
    });
    await loop.step(100);

    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'await_approval',
      owner: 'manual',
      payloadJson: JSON.stringify({
        kind: 'custom',
        label: 'Need approval',
        detail: 'delete file',
      }),
      sessionId: 'sess-1',
    });
  });

  it('dispatches planning on shared run plane and stores submitted proposal for approval', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const createAgentRun = vi.spyOn(ports.store, 'createAgentRun');
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const planFeature = vi.spyOn(ports.agents, 'planFeature');
    const graph = createProposalApprovalGraph({
      status: 'pending',
      workControl: 'planning',
      collabControl: 'none',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-feature:f-1:plan',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'plan',
        runStatus: 'ready',
      }),
    );
    expect(planFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      { agentRunId: 'run-feature:f-1:plan' },
    );
    expect(updateAgentRun).toHaveBeenNthCalledWith(1, 'run-feature:f-1:plan', {
      runStatus: 'running',
      owner: 'system',
    });
    expect(updateAgentRun).toHaveBeenNthCalledWith(2, 'run-feature:f-1:plan', {
      runStatus: 'await_approval',
      owner: 'manual',
      payloadJson: JSON.stringify(makeProposal('plan')),
    });
  });

  it('passes existing feature-phase sessionId back into resumed planning runs', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const planFeature = vi.spyOn(ports.agents, 'planFeature');
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'ready',
        sessionId: 'sess-existing',
      }),
    );
    const graph = createProposalApprovalGraph({
      status: 'pending',
      workControl: 'planning',
      collabControl: 'none',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(planFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      {
        agentRunId: 'run-feature:f-1:plan',
        sessionId: 'sess-existing',
      },
    );
  });

  it('dispatches ci_check through the verification service before agent-level verifying', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const verifyFeatureBranch = vi.spyOn(ports.verification, 'verifyFeature');
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'ci_check',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'done',
          collabControl: 'merged',
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(verifyFeatureBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
    );
  });

  it('moves ci_check into retry_await when the verification service throws', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    vi.spyOn(ports.verification, 'verifyFeature').mockRejectedValueOnce(
      new Error('feature checks failed to run'),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const graph = createSingleFeatureGraph(
      {
        status: 'pending',
        workControl: 'ci_check',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-1',
          description: 'Task 1',
          status: 'done',
          collabControl: 'merged',
        }),
      ],
    );

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    const retryFeatureCiPatch = updateAgentRun.mock.calls.find(
      ([runId, patch]) =>
        runId === 'run-feature:f-1:ci_check' &&
        patch.runStatus === 'retry_await',
    )?.[1];
    expect(updateAgentRun).toHaveBeenCalledWith(
      'run-feature:f-1:ci_check',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
      }),
    );
    expect(retryFeatureCiPatch?.retryAt).toEqual(expect.any(Number));
  });

  it('dispatches verify feature phases through the agent port', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const verifyFeature = vi.spyOn(ports.agents, 'verifyFeature');
    const graph = createSingleFeatureGraph({
      status: 'pending',
      workControl: 'verifying',
      collabControl: 'branch_open',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(verifyFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      { agentRunId: 'run-feature:f-1:verify' },
    );
  });

  it('dispatches summarize feature phases after merge in non-budget mode', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, { tokenProfile: 'balanced' });
    const summarizeFeature = vi.spyOn(ports.agents, 'summarizeFeature');
    const graph = createSingleFeatureGraph({
      status: 'done',
      workControl: 'awaiting_merge',
      collabControl: 'merged',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(summarizeFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      { agentRunId: 'run-feature:f-1:summarize' },
    );
  });

  it('does not emit feature_phase_complete when plan submits proposal for approval', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const graph = createProposalApprovalGraph({
      status: 'pending',
      workControl: 'planning',
      collabControl: 'none',
    });

    const loop = new ObservingSchedulerLoop(graph, ports);

    await loop.step(100);

    expect(loop.handledEvents).toEqual([]);
  });

  it('ignores feature-phase completion for cancelled features', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const graph = createProposalApprovalGraph({
      collabControl: 'cancelled',
      workControl: 'planning',
      status: 'in_progress',
    });
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'plan',
      summary: 'planned',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toMatchObject({
      collabControl: 'cancelled',
      workControl: 'planning',
      status: 'in_progress',
    });
    expect(updateAgentRun).not.toHaveBeenCalledWith(
      'run-feature:f-1:plan',
      expect.objectContaining({ runStatus: 'completed' }),
    );
  });

  it('ignores feature-phase errors for cancelled features', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const graph = createProposalApprovalGraph({
      collabControl: 'cancelled',
      workControl: 'planning',
      status: 'in_progress',
    });
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_error',
      featureId: 'f-1',
      phase: 'plan',
      error: 'boom',
    });
    await loop.step(100);

    expect(updateAgentRun).not.toHaveBeenCalledWith(
      'run-feature:f-1:plan',
      expect.objectContaining({ runStatus: 'retry_await' }),
    );
  });

  it('enqueues feature_phase_error after failed feature-phase work', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    vi.spyOn(ports.agents, 'planFeature').mockRejectedValueOnce(
      new Error('boom'),
    );
    const graph = createProposalApprovalGraph({
      status: 'pending',
      workControl: 'planning',
      collabControl: 'none',
    });

    const loop = new ObservingSchedulerLoop(graph, ports);

    await loop.step(100);

    expect(loop.handledEvents).toContainEqual({
      type: 'feature_phase_error',
      featureId: 'f-1',
      phase: 'plan',
      error: 'boom',
    });
  });

  it('does not redispatch a feature phase whose run is already running', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        id: 'run-feature:f-1:plan',
        runStatus: 'running',
      }),
    );
    const planFeature = vi.spyOn(ports.agents, 'planFeature');
    const graph = createProposalApprovalGraph({
      status: 'pending',
      workControl: 'planning',
      collabControl: 'none',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(planFeature).not.toHaveBeenCalled();
  });

  it('does not dispatch cancelled feature phases', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const planFeature = vi.spyOn(ports.agents, 'planFeature');
    const graph = createProposalApprovalGraph({
      status: 'in_progress',
      workControl: 'planning',
      collabControl: 'cancelled',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(planFeature).not.toHaveBeenCalled();
  });

  it('approves planning proposal, applies ops, readies root tasks, and completes run', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const graph = createProposalApprovalGraph();
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({ status: 'ready', dependsOn: [] }),
    );
    expect(graph.tasks.get('t-2')).toEqual(
      expect.objectContaining({ status: 'pending', dependsOn: ['t-1'] }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'completed',
      owner: 'system',
      payloadJson: JSON.stringify(makeProposal('plan')),
    });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proposal_applied',
        entityId: 'f-1',
        payload: expect.objectContaining({
          phase: 'plan',
          summary: '3 applied, 0 skipped, 0 warnings',
          mode: 'plan',
          appliedCount: 3,
          skippedCount: 0,
          warningCount: 0,
        }),
      }),
    );
  });

  it('rejects planning proposal, leaves graph unchanged, blocks auto-redispatch, and allows explicit rerun', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const deleteSession = vi.spyOn(ports.sessionStore, 'delete');
    const planFeature = vi.spyOn(ports.agents, 'planFeature');
    const graph = createProposalApprovalGraph();
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'sess-1',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'rejected',
      comment: 'not now',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'planning',
        status: 'in_progress',
      }),
    );
    expect(graph.tasks.size).toBe(0);
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'completed',
      owner: 'manual',
      sessionId: 'sess-1',
      payloadJson: JSON.stringify(makeProposal('plan')),
    });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proposal_rejected',
        entityId: 'f-1',
      }),
    );

    planFeature.mockClear();
    await loop.step(100);
    expect(planFeature).not.toHaveBeenCalled();

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_rerun_requested',
      featureId: 'f-1',
      phase: 'plan',
    });
    await loop.step(100);
    expect(deleteSession).toHaveBeenCalledWith('sess-1');
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      payloadJson: undefined,
    });

    planFeature.mockClear();
    loop.setAutoExecutionEnabled(true);
    await loop.step(100);
    expect(planFeature).toHaveBeenCalledOnce();
  });

  it('passes derived rerun reason into replanning', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const replanFeature = vi.spyOn(ports.agents, 'replanFeature');
    const graph = createProposalApprovalGraph(
      {
        workControl: 'replanning',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-stuck',
          description: 'Existing stuck task',
          status: 'stuck',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.appendEvent({
      eventType: 'proposal_rerun_requested',
      entityId: 'f-1',
      timestamp: Date.now(),
      payload: {
        phase: 'replan',
        summary: 'Need fresh proposal after review.',
      },
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(replanFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      'Need fresh proposal after review.',
      { agentRunId: 'run-feature:f-1:replan' },
    );
  });

  it('ignores successful verify summaries when deriving replan reason', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const replanFeature = vi.spyOn(ports.agents, 'replanFeature');
    const graph = createProposalApprovalGraph(
      {
        workControl: 'replanning',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-stuck',
          description: 'Existing stuck task',
          status: 'stuck',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: Date.now(),
      payload: {
        phase: 'verify',
        summary: 'verify green',
        extra: { ok: true, summary: 'verify green' },
      },
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(replanFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      'Scheduler requested replanning.',
      { agentRunId: 'run-feature:f-1:replan' },
    );
  });

  it('approves replanning proposal, restores stuck task, and makes approved work executable immediately', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const dispatchTask = vi.spyOn(ports.runtime, 'dispatchTask');
    const graph = createProposalApprovalGraph(
      {
        workControl: 'replanning',
        collabControl: 'branch_open',
      },
      [
        createTaskFixture({
          id: 't-stuck',
          description: 'Existing stuck task',
          status: 'stuck',
          collabControl: 'branch_open',
        }),
      ],
    );
    ports.store.createAgentRun(
      makeFeaturePhaseRun('replan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(makeProposal('replan')),
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'replan',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.tasks.get('t-stuck')).toEqual(
      expect.objectContaining({ status: 'ready', dependsOn: [] }),
    );
    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({ status: 'ready', dependsOn: [] }),
    );
    expect(graph.tasks.get('t-2')).toEqual(
      expect.objectContaining({ status: 'pending', dependsOn: ['t-1'] }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:replan', {
      runStatus: 'completed',
      owner: 'system',
      payloadJson: JSON.stringify(makeProposal('replan')),
    });

    loop.setAutoExecutionEnabled(true);
    await loop.step(101);

    const dispatchedIds = dispatchTask.mock.calls.map(([task]) => task.id);
    expect(dispatchedIds).toEqual(expect.arrayContaining(['t-stuck', 't-1']));
    expect(dispatchedIds).not.toContain('t-2');
  });

  it('records proposal_apply_failed when approval payload is invalid', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const graph = createProposalApprovalGraph();
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: '{bad-json',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.tasks.size).toBe(0);
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'planning',
        status: 'in_progress',
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'completed',
      owner: 'manual',
      payloadJson: '{bad-json',
    });
    const proposalApplyFailedEvent = appendEvent.mock.calls[0]?.[0];
    expect(proposalApplyFailedEvent).toMatchObject({
      eventType: 'proposal_apply_failed',
      entityId: 'f-1',
    });
    expect(proposalApplyFailedEvent?.payload).toMatchObject({
      phase: 'plan',
    });
    expect(proposalApplyFailedEvent?.payload?.error).toContain('JSON');
  });

  it('keeps feature in planning when approved proposal applies no ops', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const graph = createProposalApprovalGraph();
    const noOpProposal: GraphProposal = {
      version: 1,
      mode: 'plan',
      aliases: {},
      ops: [
        {
          kind: 'remove_task',
          taskId: 't-missing',
        },
      ],
    };
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(noOpProposal),
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'planning',
        status: 'in_progress',
      }),
    );
    expect(graph.tasks.size).toBe(0);
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'completed',
      owner: 'system',
      payloadJson: JSON.stringify(noOpProposal),
    });
  });

  it('advances planning feature when approved proposal adds only milestone and sibling feature', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const graph = createProposalApprovalGraph();
    const siblingFeatureProposal: GraphProposal = {
      version: 1,
      mode: 'plan',
      aliases: {},
      ops: [
        {
          kind: 'add_milestone',
          milestoneId: 'm-2',
          name: 'Milestone 2',
          description: 'second milestone',
        },
        {
          kind: 'add_feature',
          featureId: 'f-2',
          milestoneId: 'm-2',
          name: 'Interface feature',
          description: 'shared prerequisite work',
        },
      ],
    };
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(siblingFeatureProposal),
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.milestones.get('m-2')).toEqual(
      expect.objectContaining({ name: 'Milestone 2' }),
    );
    expect(graph.features.get('f-2')).toEqual(
      expect.objectContaining({
        milestoneId: 'm-2',
        name: 'Interface feature',
      }),
    );
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'ci_check',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.tasks.size).toBe(0);
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'completed',
      owner: 'system',
      payloadJson: JSON.stringify(siblingFeatureProposal),
    });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proposal_applied',
        entityId: 'f-1',
        payload: expect.objectContaining({
          phase: 'plan',
          summary: '2 applied, 0 skipped, 0 warnings',
          appliedCount: 2,
          skippedCount: 0,
          warningCount: 0,
        }),
      }),
    );
  });

  it('records proposal_apply_failed when proposal op shape is invalid', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const graph = createProposalApprovalGraph();
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify({
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [{ kind: 'drop_database' }],
        }),
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });
    await loop.step(100);

    const invalidProposalEvent = appendEvent.mock.calls[0]?.[0];
    expect(invalidProposalEvent).toMatchObject({
      eventType: 'proposal_apply_failed',
      entityId: 'f-1',
    });
    expect(invalidProposalEvent?.payload).toMatchObject({
      phase: 'plan',
      error: 'invalid proposal payload',
    });
  });

  it('moves ci_check success into verifying', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, {
      verification: {
        feature: {
          checks: [{ description: 'Typecheck', command: 'npm run typecheck' }],
          timeoutSecs: 600,
          continueOnFail: false,
        },
      },
    });
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
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
          workControl: 'ci_check',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Task 1',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
      ],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('ci_check'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'ci_check',
      summary: 'green',
      verification: { ok: true, summary: 'green' },
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'verifying',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:ci_check', {
      runStatus: 'completed',
      owner: 'system',
    });
    const featureCiEvent = appendEvent.mock.calls.find(
      ([event]) => event.eventType === 'feature_phase_completed',
    )?.[0];
    expect(featureCiEvent).toMatchObject({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
    });
    expect(featureCiEvent?.payload).toMatchObject({
      phase: 'ci_check',
      summary: 'green',
      extra: {
        ok: true,
        summary: 'green',
      },
    });
    const emptyCheckWarning = appendEvent.mock.calls.find(
      ([event]) =>
        event.eventType === 'warning_emitted' &&
        event.entityId === 'f-1' &&
        event.payload?.category === 'empty_verification_checks',
    );
    expect(emptyCheckWarning).toBeUndefined();
  });

  it('keeps empty-check warning deduped across later ticks when warning history is unavailable', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, {
      verification: {
        feature: {
          checks: [],
          timeoutSecs: 600,
          continueOnFail: false,
        },
      },
    });
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const listEvents = vi.spyOn(ports.store, 'listEvents');
    const graph = createProposalApprovalGraph({
      status: 'in_progress',
      workControl: 'ci_check',
      collabControl: 'branch_open',
    });
    const loop = new SchedulerLoop(graph, ports);
    const emitEmptyVerificationChecksWarning = Reflect.get(
      loop as object,
      'emitEmptyVerificationChecksWarning',
    ) as (entityId: 'f-1', layer: 'feature', now: number) => void;

    emitEmptyVerificationChecksWarning.call(loop, 'f-1', 'feature', 10);
    await loop.step(100);

    listEvents.mockImplementation((query?: EventQuery) =>
      query?.eventType === 'warning_emitted' ? [] : [],
    );
    emitEmptyVerificationChecksWarning.call(loop, 'f-1', 'feature', 20);

    const warningEvents = appendEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.eventType === 'warning_emitted' &&
          event.entityId === 'f-1' &&
          event.payload?.category === 'empty_verification_checks',
      );
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      extra: { layer: 'feature' },
    });
  });

  it('does not emit empty-check warning when mergeTrain is omitted but feature checks exist', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, {
      verification: {
        feature: {
          checks: [{ description: 'Typecheck', command: 'npm run typecheck' }],
          timeoutSecs: 600,
          continueOnFail: false,
        },
      },
    });
    const loop = new SchedulerLoop(createProposalApprovalGraph(), ports);

    await loop.step(100);

    const warningEvents = ports.store
      .listEvents({ eventType: 'warning_emitted', entityId: 'f-1' })
      .filter(
        (event) => event.payload?.category === 'empty_verification_checks',
      );
    expect(warningEvents).toHaveLength(0);
  });

  it('moves verify success through merge_queued into integrating', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
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
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('verify'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'verified',
      verification: { ok: true, summary: 'verified' },
    });
    await loop.step(100);

    // After step() the feature advances: handleEvent sets workControl=awaiting_merge
    // and collabControl=merge_queued (with mergeTrainEntrySeq assigned), then
    // features.beginNextIntegration() in the same tick transitions collabControl
    // to 'integrating'. Both transitions are observable through the mergeTrainEntrySeq
    // stamp being preserved.
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'awaiting_merge',
        status: 'in_progress',
        collabControl: 'integrating',
        mergeTrainEntrySeq: 1,
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:verify', {
      runStatus: 'completed',
      owner: 'system',
    });
  });

  it('moves ci_check failure into executing_repair and creates a ready repair task', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'ci_check',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Task 1',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
      ],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('ci_check'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'ci_check',
      summary: 'tests failed',
      verification: { ok: false, summary: 'tests failed' },
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing_repair',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-1' && task.id !== 't-1',
    );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      status: 'ready',
      collabControl: 'none',
      repairSource: 'ci_check',
    });
    expect(repairTasks[0]?.description).toContain('Repair ci check issues');
  });

  it('routes verify failure directly to replanning', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('verify'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'failed checks',
      verification: { ok: false, summary: 'failed checks' },
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'replanning',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect([...graph.tasks.values()]).toHaveLength(0);
  });

  it('routes verify failure to replanning regardless of prior repair-named tasks', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Repair login flow',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
      ],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('verify'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'failed checks',
      verification: { ok: false, summary: 'failed checks' },
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'replanning',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.repairSource !== undefined,
    );
    expect(repairTasks).toHaveLength(0);
  });

  it('escalates repeated pre-queue verification failure to replanning', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Repair feature verification issues: previous failure',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
          repairSource: 'verify',
        },
      ],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('verify'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'failed again',
      verification: { ok: false, summary: 'failed again' },
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'replanning',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect([...graph.tasks.values()]).toHaveLength(1);
  });

  it('rejects ci_check completion when verification payload is missing', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'ci_check',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Task 1',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
      ],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('ci_check'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'ci_check',
      summary: 'green',
    });
    await expect(loop.step(100)).rejects.toThrow(
      'ci_check completion requires verification summary',
    );
  });

  it('rejects verify completion when verification payload is missing', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('verify'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'verified',
    });
    await expect(loop.step(100)).rejects.toThrow(
      'verify completion requires verification summary',
    );
  });

  it('does not rerun ci_check while a repair task remains incomplete', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const verifyFeatureBranch = vi.spyOn(ports.verification, 'verifyFeature');
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
          status: 'pending',
          workControl: 'executing_repair',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Original task',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
        {
          id: 't-2',
          featureId: 'f-1',
          orderInFeature: 1,
          description: 'Repair task',
          dependsOn: [],
          status: 'ready',
          collabControl: 'none',
        },
      ],
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing_repair',
        collabControl: 'branch_open',
      }),
    );
    expect(verifyFeatureBranch).not.toHaveBeenCalled();
  });

  it('returns executing_repair to ci_check after the repair task lands', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'executing_repair',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Original task',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
        },
        {
          id: 't-2',
          featureId: 'f-1',
          orderInFeature: 1,
          description: 'Repair task',
          dependsOn: [],
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-2',
        scopeId: 't-2',
        runStatus: 'running',
        sessionId: 'sess-2',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-2',
        agentRunId: 'run-task:t-2',
        result: {
          summary: 'repaired',
          filesChanged: ['src/fix.ts'],
        },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'ci_check',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.tasks.get('t-2')).toEqual(
      expect.objectContaining({
        status: 'done',
        collabControl: 'merged',
      }),
    );
  });

  it('moves merged features into summarizing on the next tick in non-budget mode', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSingleFeatureGraph({
      status: 'done',
      workControl: 'awaiting_merge',
      collabControl: 'merged',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'summarizing',
        status: 'pending',
        collabControl: 'merged',
      }),
    );
    const feature = graph.features.get('f-1');
    expect(feature).toBeDefined();
    expect(deriveSummaryAvailability(feature as Feature)).toBe('waiting');
  });

  it('skips summarizing in budget mode after merge', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, { tokenProfile: 'budget' });
    const graph = createSingleFeatureGraph({
      status: 'done',
      workControl: 'awaiting_merge',
      collabControl: 'merged',
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
      }),
    );
    const feature = graph.features.get('f-1');
    expect(feature).toBeDefined();
    expect(feature?.summary).toBeUndefined();
    expect(deriveSummaryAvailability(feature as Feature)).toBe('skipped');
  });

  it('persists summary text and reaches work_complete after summarize completion', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
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
          workControl: 'summarizing',
          collabControl: 'merged',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('summarize'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'summarize',
      summary: 'final summary',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
        summary: 'final summary',
      }),
    );
    const feature = graph.features.get('f-1');
    expect(feature).toBeDefined();
    expect(deriveSummaryAvailability(feature as Feature)).toBe('available');
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:summarize', {
      runStatus: 'completed',
      owner: 'system',
    });
  });

  it('rejects empty summarize completion because normal summarize must write text', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'summarizing',
          collabControl: 'merged',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('summarize'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'summarize',
      summary: '',
    });
    await expect(loop.step(100)).rejects.toThrow(
      'summarize completion requires summary text',
    );
  });

  it('begins integrating the next merge-queued feature on tick', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          status: 'pending',
          workControl: 'awaiting_merge',
          collabControl: 'merge_queued',
          featureBranch: 'feat-feature-1-1',
          mergeTrainEntrySeq: 1,
          mergeTrainReentryCount: 0,
        },
      ],
      tasks: [],
    });

    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        collabControl: 'integrating',
        status: 'in_progress',
        workControl: 'awaiting_merge',
      }),
    );
  });

  it('completes integration and moves the merged feature into summarizing on the same tick', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, { tokenProfile: 'balanced' });
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
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
          mergeTrainEntrySeq: 1,
          mergeTrainReentryCount: 0,
        },
      ],
      tasks: [],
    });

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    const feature = graph.features.get('f-1');
    expect(feature).toBeDefined();
    expect(feature).toEqual(
      expect.objectContaining({
        collabControl: 'merged',
        workControl: 'summarizing',
        status: 'pending',
      }),
    );
    expect(feature?.mergeTrainManualPosition).toBeUndefined();
    expect(feature?.mergeTrainEnteredAt).toBeUndefined();
    expect(feature?.mergeTrainEntrySeq).toBeUndefined();
    expect(feature?.mergeTrainReentryCount).toBe(0);
  });

  it('suspends whole secondary feature when cross-feature runtime overlap appears', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
        createFeatureFixture({
          id: 'f-2',
          orderInMilestone: 1,
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-3',
          featureId: 'f-2',
          orderInFeature: 1,
          status: 'ready',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-1',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-3')).toMatchObject({
      status: 'ready',
      collabControl: 'branch_open',
    });
    expect(suspendTask).toHaveBeenCalledTimes(1);
    expect(suspendTask).toHaveBeenCalledWith('t-2', 'cross_feature_overlap', [
      'src/a.ts',
    ]);
  });

  it('suspends secondary-feature running tasks without overlapping reservations on cross-feature overlap', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
        createFeatureFixture({
          id: 'f-2',
          orderInMilestone: 1,
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-3',
          featureId: 'f-2',
          orderInFeature: 1,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/unrelated.ts'],
        }),
        createTaskFixture({
          id: 't-4',
          featureId: 'f-2',
          orderInFeature: 2,
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-1',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-3')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-1',
    });
    expect(graph.tasks.get('t-3')?.suspendedFiles).toBeUndefined();
    expect(graph.tasks.get('t-4')).toMatchObject({
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      blockedByFeatureId: 'f-1',
    });
    expect(graph.tasks.get('t-4')?.suspendedFiles).toBeUndefined();
    expect(suspendTask).toHaveBeenCalledTimes(3);
    expect(suspendTask).toHaveBeenCalledWith('t-2', 'cross_feature_overlap', [
      'src/a.ts',
    ]);
    expect(suspendTask).toHaveBeenCalledWith(
      't-3',
      'cross_feature_overlap',
      [],
    );
    expect(suspendTask).toHaveBeenCalledWith(
      't-4',
      'cross_feature_overlap',
      [],
    );
  });

  it('prefers dependency predecessor as cross-feature overlap primary', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
          dependsOn: ['f-2'],
        }),
        createFeatureFixture({
          id: 'f-2',
          orderInMilestone: 1,
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-1')?.runtimeBlockedByFeatureId).toBe('f-2');
    expect(
      graph.features.get('f-2')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.tasks.get('t-1')).toMatchObject({
      collabControl: 'suspended',
      blockedByFeatureId: 'f-2',
      suspendReason: 'cross_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'branch_open',
    });
  });

  it('prefers nearer-to-merge feature as cross-feature overlap primary', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
        createFeatureFixture({
          id: 'f-2',
          orderInMilestone: 1,
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'merge_queued',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-1')?.runtimeBlockedByFeatureId).toBe('f-2');
    expect(
      graph.features.get('f-2')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.tasks.get('t-1')).toMatchObject({
      collabControl: 'suspended',
      blockedByFeatureId: 'f-2',
      suspendReason: 'cross_feature_overlap',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'branch_open',
    });
  });

  it('prefers older milestone order when merge proximity ties', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSchedulerGraph({
      milestones: [
        createMilestoneFixture({ id: 'm-1', order: 0 }),
        createMilestoneFixture({ id: 'm-2', order: 1 }),
      ],
      features: [
        createFeatureFixture({
          id: 'f-1',
          milestoneId: 'm-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
        createFeatureFixture({
          id: 'f-2',
          milestoneId: 'm-2',
          orderInMilestone: 0,
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-2')?.runtimeBlockedByFeatureId).toBe('f-1');
    expect(
      graph.features.get('f-1')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
  });

  it('prefers feature blocking more downstream dependents when earlier signals tie', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
          orderInMilestone: 0,
        }),
        createFeatureFixture({
          id: 'f-2',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
          orderInMilestone: 0,
        }),
        createFeatureFixture({
          id: 'f-3',
          orderInMilestone: 1,
          status: 'pending',
          workControl: 'discussing',
          collabControl: 'none',
          dependsOn: ['f-1'],
        }),
        createFeatureFixture({
          id: 'f-4',
          orderInMilestone: 2,
          status: 'pending',
          workControl: 'discussing',
          collabControl: 'none',
          dependsOn: ['f-3'],
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-2')?.runtimeBlockedByFeatureId).toBe('f-1');
    expect(
      graph.features.get('f-1')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
  });

  it('does not cascade stale blocked feature into new primary within same tick', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    vi.spyOn(runtime, 'idleWorkerCount').mockReturnValue(0);
    const suspendTask = vi.spyOn(runtime, 'suspendTask');
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
        createFeatureFixture({
          id: 'f-2',
          orderInMilestone: 1,
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
        createFeatureFixture({
          id: 'f-3',
          orderInMilestone: 2,
          status: 'in_progress',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/a.ts', 'src/b.ts'],
        }),
        createTaskFixture({
          id: 't-3',
          featureId: 'f-3',
          orderInFeature: 0,
          status: 'running',
          collabControl: 'branch_open',
          reservedWritePaths: ['src/b.ts'],
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
    });
    expect(
      graph.features.get('f-3')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.tasks.get('t-2')).toMatchObject({
      collabControl: 'suspended',
      blockedByFeatureId: 'f-1',
      suspendedFiles: ['src/a.ts'],
    });
    expect(graph.tasks.get('t-3')).toMatchObject({
      collabControl: 'branch_open',
    });
    expect(suspendTask).toHaveBeenCalledTimes(1);
    expect(suspendTask).toHaveBeenCalledWith('t-2', 'cross_feature_overlap', [
      'src/a.ts',
    ]);
  });

  it('releases cross-feature blocked tasks when primary integration completes after clean secondary rebase', async () => {
    const root = getTmpDir();
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const resumeTask = vi
      .spyOn(runtime, 'resumeTask')
      .mockImplementation((taskId: string) =>
        Promise.resolve({
          kind: 'delivered',
          taskId,
          agentRunId: `run-${taskId}`,
        }),
      );
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
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          featureBranch: 'feat-feature-2-1',
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
          suspendedAt: 75,
          worktreeBranch: 'feat-feature-2-1-task-2',
          reservedWritePaths: ['src/a.ts'],
        },
      ],
    });

    const blockedFeature = graph.features.get('f-2');
    const blockedTask = graph.tasks.get('t-2');
    assert(
      blockedFeature !== undefined &&
        blockedTask !== undefined &&
        blockedTask.worktreeBranch !== undefined,
      'missing blocked feature fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, blockedFeature);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', blockedFeature.featureBranch);

    const taskDir = path.join(root, worktreePath(blockedTask.worktreeBranch));
    await git(
      featureDir,
      'worktree',
      'add',
      taskDir,
      '-b',
      blockedTask.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task work\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    expect(
      graph.features.get('f-2')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.tasks.get('t-2')).toMatchObject({
      status: 'running',
      collabControl: 'branch_open',
    });
    expect(graph.tasks.get('t-2')?.blockedByFeatureId).toBeUndefined();
    expect(graph.tasks.get('t-2')?.suspendReason).toBeUndefined();
    expect(graph.tasks.get('t-2')?.suspendedAt).toBeUndefined();
    expect(resumeTask).toHaveBeenCalledWith('t-2', 'cross_feature_rebase');
  }, 20000);

  it('falls back to runtime resume dispatch after restart when blocked task becomes ready again', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');
    const graph = createSingleTaskDispatchGraph({
      task: {
        collabControl: 'branch_open',
        status: 'ready',
      },
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        scopeId: 't-1',
        runStatus: 'ready',
        sessionId: 'sess-1',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(100);

    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: 'run-task:t-1',
        sessionId: 'sess-1',
      },
      expect.any(Object),
    );
  });

  it('emits long blocking warning once when runtime block exceeds threshold', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, {
      tokenProfile: 'balanced',
      warnings: { longFeatureBlockingMs: 1000 },
    });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
        }),
        createFeatureFixture({
          id: 'f-2',
          orderInMilestone: 1,
          workControl: 'executing',
          collabControl: 'branch_open',
          runtimeBlockedByFeatureId: 'f-1',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          status: 'running',
          collabControl: 'suspended',
          blockedByFeatureId: 'f-1',
          suspendReason: 'cross_feature_overlap',
          suspendedAt: 0,
        }),
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    await loop.step(1001);
    await loop.step(2000);

    const warningCalls = appendEvent.mock.calls.filter(
      ([event]) => event.eventType === 'warning_emitted',
    );
    expect(warningCalls).toHaveLength(1);
    const warningEvent = warningCalls[0]?.[0];
    expect(warningEvent).toMatchObject({
      eventType: 'warning_emitted',
      entityId: 'f-2',
      timestamp: 1001,
    });
    expect(warningEvent?.payload).toMatchObject({
      category: 'long_feature_blocking',
    });
  });

  it('emits verify_replan_loop warning when failed verify count hits threshold', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, {
      tokenProfile: 'balanced',
      warnings: {
        longFeatureBlockingMs: 1000,
        verifyReplanLoopThreshold: 3,
      },
    });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          workControl: 'verifying',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [],
    });

    for (let i = 0; i < 3; i++) {
      ports.store.appendEvent({
        eventType: 'feature_phase_completed',
        entityId: 'f-1',
        timestamp: 100 + i,
        payload: {
          phase: 'verify',
          summary: `verify failure ${i}`,
          extra: { ok: false, outcome: 'repair_needed' },
        },
      });
    }

    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const loop = new SchedulerLoop(graph, ports);
    await loop.step(1000);
    await loop.step(2000);

    const loopWarnings = appendEvent.mock.calls.filter(
      ([event]) =>
        event.eventType === 'warning_emitted' &&
        (event.payload as { category?: string }).category ===
          'verify_replan_loop',
    );
    expect(loopWarnings).toHaveLength(1);
    expect(loopWarnings[0]?.[0]).toMatchObject({
      entityId: 'f-1',
      payload: {
        category: 'verify_replan_loop',
        extra: { failedVerifyCount: 3 },
      },
    });
  });

  it('does not emit verify_replan_loop after a successful replan resets the count', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, {
      tokenProfile: 'balanced',
      warnings: {
        longFeatureBlockingMs: 1000,
        verifyReplanLoopThreshold: 3,
      },
    });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          workControl: 'verifying',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [],
    });

    for (let i = 0; i < 3; i++) {
      ports.store.appendEvent({
        eventType: 'feature_phase_completed',
        entityId: 'f-1',
        timestamp: 100 + i,
        payload: {
          phase: 'verify',
          summary: `verify failure ${i}`,
          extra: { ok: false, outcome: 'repair_needed' },
        },
      });
    }
    ports.store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: 200,
      payload: {
        phase: 'replan',
        summary: 'replan landed',
      },
    });
    ports.store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: 300,
      payload: {
        phase: 'verify',
        summary: 'verify failure after replan',
        extra: { ok: false, outcome: 'repair_needed' },
      },
    });

    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const loop = new SchedulerLoop(graph, ports);
    await loop.step(1000);

    const loopWarnings = appendEvent.mock.calls.filter(
      ([event]) =>
        event.eventType === 'warning_emitted' &&
        (event.payload as { category?: string }).category ===
          'verify_replan_loop',
    );
    expect(loopWarnings).toHaveLength(0);
  });

  it('creates integration repair and keeps tasks suspended when secondary rebase conflicts', async () => {
    const root = getTmpDir();
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const resumeTask = vi.spyOn(runtime, 'resumeTask');
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
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          featureBranch: 'feat-feature-2-1',
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
          suspendedAt: 75,
        },
      ],
    });

    const blockedFeature = graph.features.get('f-2');
    assert(
      blockedFeature !== undefined,
      'missing blocked feature fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, blockedFeature);
    await git(featureDir, 'checkout', blockedFeature.featureBranch);
    await fs.writeFile(
      path.join(featureDir, 'src', 'a.ts'),
      'feature change\n',
    );
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'feature change');
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main change\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main change');
    await git(featureDir, 'checkout', blockedFeature.featureBranch);

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
      collabControl: 'conflict',
      workControl: 'executing_repair',
      status: 'pending',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      status: 'running',
      collabControl: 'suspended',
      blockedByFeatureId: 'f-1',
      suspendReason: 'cross_feature_overlap',
    });
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      status: 'ready',
      description:
        'Repair integration issues: Rebase onto main conflicted in src/a.ts',
    });
    expect(resumeTask).not.toHaveBeenCalled();
  }, 20000);

  it('keeps clean-rebased task ready when runtime resume delivery fails', async () => {
    const root = getTmpDir();
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const resumeTask = vi
      .spyOn(runtime, 'resumeTask')
      .mockImplementation((taskId: string) =>
        Promise.resolve({
          kind: 'not_running',
          taskId,
        }),
      );
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
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          featureBranch: 'feat-feature-2-1',
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
          suspendedAt: 75,
          worktreeBranch: 'feat-feature-2-1-task-2',
          reservedWritePaths: ['src/a.ts'],
        },
      ],
    });

    const blockedFeature = graph.features.get('f-2');
    const blockedTask = graph.tasks.get('t-2');
    assert(
      blockedFeature !== undefined &&
        blockedTask !== undefined &&
        blockedTask.worktreeBranch !== undefined,
      'missing blocked feature fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, blockedFeature);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', blockedFeature.featureBranch);

    const taskDir = path.join(root, worktreePath(blockedTask.worktreeBranch));
    await git(
      featureDir,
      'worktree',
      'add',
      taskDir,
      '-b',
      blockedTask.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'b.ts'), 'task work\n');
    await git(taskDir, 'add', 'src/b.ts');
    await git(taskDir, 'commit', '-m', 'task work');

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    expect(
      graph.features.get('f-2')?.runtimeBlockedByFeatureId,
    ).toBeUndefined();
    expect(graph.tasks.get('t-2')).toMatchObject({
      status: 'ready',
      collabControl: 'branch_open',
    });
    expect(graph.tasks.get('t-2')?.blockedByFeatureId).toBeUndefined();
    expect(graph.tasks.get('t-2')?.suspendReason).toBeUndefined();
    expect(resumeTask).toHaveBeenCalledWith('t-2', 'cross_feature_rebase');
  }, 20000);

  it('creates integration repair when blocked secondary task rebase conflicts after clean feature rebase', async () => {
    const root = getTmpDir();
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const resumeTask = vi.spyOn(runtime, 'resumeTask');
    const steerTask = vi.spyOn(runtime, 'steerTask');
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
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          featureBranch: 'feat-feature-2-1',
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
          suspendedAt: 75,
          worktreeBranch: 'feat-feature-2-1-task-2',
          reservedWritePaths: ['src/a.ts'],
          suspendedFiles: ['src/a.ts'],
        },
      ],
    });

    const blockedFeature = graph.features.get('f-2');
    const blockedTask = graph.tasks.get('t-2');
    assert(
      blockedFeature !== undefined &&
        blockedTask !== undefined &&
        blockedTask.worktreeBranch !== undefined,
      'missing blocked feature fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, blockedFeature);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', blockedFeature.featureBranch);

    const taskDir = path.join(root, worktreePath(blockedTask.worktreeBranch));
    await git(
      featureDir,
      'worktree',
      'add',
      taskDir,
      '-b',
      blockedTask.worktreeBranch,
    );
    await fs.writeFile(path.join(taskDir, 'src', 'a.ts'), 'task change\n');
    await git(taskDir, 'add', 'src/a.ts');
    await git(taskDir, 'commit', '-m', 'task change');

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
      collabControl: 'conflict',
      workControl: 'executing_repair',
      status: 'pending',
    });
    expect(graph.tasks.get('t-2')).toMatchObject({
      status: 'running',
      collabControl: 'suspended',
      blockedByFeatureId: 'f-1',
      suspendReason: 'cross_feature_overlap',
    });
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      status: 'ready',
      description:
        'Repair integration issues: Cross-feature task rebase conflicted for t-2: src/a.ts',
    });
    expect(resumeTask).not.toHaveBeenCalled();
    expect(steerTask).not.toHaveBeenCalled();
  }, 20000);

  it('creates integration repair when blocked secondary task worktree is missing after clean feature rebase', async () => {
    const root = getTmpDir();
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const resumeTask = vi.spyOn(runtime, 'resumeTask');
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
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          featureBranch: 'feat-feature-2-1',
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
          suspendedAt: 75,
          worktreeBranch: 'feat-feature-2-1-task-2',
          reservedWritePaths: ['src/a.ts'],
        },
      ],
    });

    const blockedFeature = graph.features.get('f-2');
    assert(
      blockedFeature !== undefined,
      'missing blocked feature fixture state',
    );

    const featureDir = await writeFeatureRebaseRepo(root, blockedFeature);
    await git(featureDir, 'checkout', 'main');
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'main update\n');
    await git(featureDir, 'add', 'src/a.ts');
    await git(featureDir, 'commit', '-m', 'main update');
    await git(featureDir, 'checkout', blockedFeature.featureBranch);

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
      collabControl: 'conflict',
      workControl: 'executing_repair',
      status: 'pending',
    });
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      status: 'ready',
      description: 'Repair integration issues: Task worktree missing for t-2',
    });
    expect(resumeTask).not.toHaveBeenCalled();
  }, 20000);

  it('creates integration repair when blocked secondary feature worktree is missing', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order, { tokenProfile: 'balanced' });
    vi.spyOn(ports.runtime, 'idleWorkerCount').mockReturnValue(0);
    const resumeTask = vi.spyOn(runtime, 'resumeTask');
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
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          featureBranch: 'feat-feature-2-1',
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
          suspendedAt: 75,
        },
      ],
    });

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.step(100);

    expect(graph.features.get('f-2')).toMatchObject({
      runtimeBlockedByFeatureId: 'f-1',
      collabControl: 'conflict',
      workControl: 'executing_repair',
      status: 'pending',
    });
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      status: 'ready',
      description:
        'Repair integration issues: Feature worktree missing for f-2',
    });
    expect(resumeTask).not.toHaveBeenCalled();
  });

  it('ejects failed integration into conflict and starts the next queued feature', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'desc',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'integrating',
          featureBranch: 'feat-feature-1-1',
          mergeTrainManualPosition: 1,
          mergeTrainEnteredAt: 50,
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
          status: 'pending',
          workControl: 'awaiting_merge',
          collabControl: 'merge_queued',
          featureBranch: 'feat-feature-2-1',
          mergeTrainEntrySeq: 2,
          mergeTrainReentryCount: 0,
        },
      ],
      tasks: [],
    });

    const loop = new SchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_failed',
      featureId: 'f-1',
      error: 'rebase failed',
    });

    await loop.step(100);

    const failedFeature = graph.features.get('f-1');
    expect(failedFeature).toBeDefined();
    expect(failedFeature).toEqual(
      expect.objectContaining({
        collabControl: 'conflict',
        workControl: 'executing_repair',
        status: 'pending',
        mergeTrainReentryCount: 1,
      }),
    );
    expect(failedFeature?.mergeTrainManualPosition).toBeUndefined();
    expect(failedFeature?.mergeTrainEnteredAt).toBeUndefined();
    expect(failedFeature?.mergeTrainEntrySeq).toBeUndefined();
    expect(graph.features.get('f-2')).toEqual(
      expect.objectContaining({
        collabControl: 'integrating',
        workControl: 'awaiting_merge',
        status: 'in_progress',
      }),
    );
  });

  it('replans when integration repair lands but task resume stays blocked again', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, { tokenProfile: 'balanced' });
    const graph = createSchedulerGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-2',
          status: 'in_progress',
          workControl: 'executing_repair',
          collabControl: 'conflict',
          runtimeBlockedByFeatureId: 'f-1',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-repair',
          featureId: 'f-2',
          status: 'running',
          collabControl: 'branch_open',
          repairSource: 'integration',
          result: { summary: 'repair done', filesChanged: ['src/a.ts'] },
        }),
        createTaskFixture({
          id: 't-suspended',
          featureId: 'f-2',
          orderInFeature: 1,
          status: 'running',
          collabControl: 'suspended',
          blockedByFeatureId: 'f-1',
          suspendReason: 'cross_feature_overlap',
          suspendedAt: 75,
          worktreeBranch: 'feat-feature-2-task-suspended',
        }),
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-repair',
        scopeId: 't-repair',
        runStatus: 'running',
        sessionId: 'sess-repair',
      }),
    );

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-repair',
        agentRunId: 'run-task:t-repair',
        result: {
          summary: 'repair done',
          filesChanged: ['src/a.ts'],
        },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });
    await loop.step(100);

    const repairedFeature = graph.features.get('f-2');
    expect(repairedFeature?.runtimeBlockedByFeatureId).toBeUndefined();
    expect(repairedFeature).toMatchObject({
      collabControl: 'conflict',
      workControl: 'replanning',
      status: 'pending',
    });
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-2' && task.repairSource === 'integration',
    );
    expect(repairTasks).toHaveLength(1);
  });

  it('puts feature-phase errors into retry_await on the shared run plane', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const graph = createProposalApprovalGraph();
    ports.store.createAgentRun(makeFeaturePhaseRun('plan'));

    const loop = new SchedulerLoop(graph, ports);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_error',
      featureId: 'f-1',
      phase: 'plan',
      error: 'boom',
    });
    await loop.step(100);

    const retryPlanPatch = updateAgentRun.mock.calls.find(
      ([runId, patch]) =>
        runId === 'run-feature:f-1:plan' && patch.runStatus === 'retry_await',
    )?.[1];
    expect(updateAgentRun).toHaveBeenCalledWith(
      'run-feature:f-1:plan',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
      }),
    );
    expect(retryPlanPatch?.retryAt).toEqual(expect.any(Number));
  });
});
