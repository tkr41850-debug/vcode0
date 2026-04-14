import type { PlannerAgent, ReplannerAgent } from '@agents/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type { GraphProposal } from '@core/proposals/index';
import { deriveSummaryAvailability } from '@core/state';
import type {
  AgentRun,
  AgentRunPhase,
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  GvcConfig,
  Task,
  TaskAgentRun,
  VerificationSummary,
} from '@core/types/index';
import type {
  AgentRunQuery,
  EventQuery,
  OrchestratorPorts,
  Store,
  UiPort,
  VerificationPort,
} from '@orchestrator/ports/index';
import {
  type SchedulerEvent,
  SchedulerLoop,
} from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

class ExposedSchedulerLoop extends SchedulerLoop {
  async tickForTest(now: number): Promise<void> {
    return super.tick(now);
  }

  async dispatchReadyWorkForTest(now: number): Promise<void> {
    return super.dispatchReadyWork(now);
  }

  async handleEventForTest(event: SchedulerEvent): Promise<void> {
    return super.handleEvent(event);
  }
}

class RecordingSchedulerLoop extends ExposedSchedulerLoop {
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

class ObservingSchedulerLoop extends ExposedSchedulerLoop {
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
    updateAgentRun: (
      runId: string,
      patch: Partial<Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>>,
    ) => {
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
    dispatchTask: async (_task: Task, _dispatch) => ({
      kind: 'started',
      taskId: 't-1',
      agentRunId: 'run-1',
      sessionId: 'sess-1',
    }),
    steerTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    suspendTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    resumeTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    abortTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    idleWorkerCount: () => 4,
    stopAll: vi.fn(async () => {
      order.push('stopAll');
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

function createAgentMock(): PlannerAgent & ReplannerAgent {
  const featureResult: FeaturePhaseResult = { summary: 'ok' };
  const verificationResult: VerificationSummary = { ok: true };

  return {
    discussFeature: async (_feature: Feature, _run: FeaturePhaseRunContext) =>
      featureResult,
    researchFeature: async (_feature: Feature, _run: FeaturePhaseRunContext) =>
      featureResult,
    planFeature: async (_feature: Feature, _run: FeaturePhaseRunContext) => ({
      summary: 'ok',
      proposal: makeProposal('plan'),
    }),
    verifyFeature: async (_feature: Feature, _run: FeaturePhaseRunContext) =>
      verificationResult,
    summarizeFeature: async (_feature: Feature, _run: FeaturePhaseRunContext) =>
      featureResult,
    replanFeature: async (
      _feature: Feature,
      _reason: string,
      _run: FeaturePhaseRunContext,
    ) => ({
      summary: 'ok',
      proposal: makeProposal('replan'),
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

  return {
    ports: (() => {
      const base = {
        store: createStoreMock(),
        runtime,
        agents: createAgentMock(),
        ui,
        config: createConfig(configOverrides),
      };
      let verification: VerificationPort;
      const ports = {
        ...base,
        get verification() {
          return verification;
        },
      } as OrchestratorPorts;
      verification = new VerificationService(ports);
      return {
        ...base,
        verification,
      };
    })(),
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

afterEach(() => {
  vi.useRealTimers();
});

describe('SchedulerLoop', () => {
  it('stores typed events until the next scheduler tick', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      new InMemoryFeatureGraph(),
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
      new InMemoryFeatureGraph(),
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
      'refresh',
    ]);

    await loop.stop();
  });

  it('runs on a 1-second interval and refreshes the UI on each tick', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports, ui } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      new InMemoryFeatureGraph(),
      ports,
      order,
    );

    await loop.run();

    expect(ui.refresh).not.toHaveBeenCalled();
    expect(loop.dispatchTimes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.refresh).toHaveBeenCalledTimes(1);
    expect(loop.dispatchTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.refresh).toHaveBeenCalledTimes(2);
    expect(loop.dispatchTimes).toHaveLength(2);

    await loop.stop();
  });

  it('stops the interval and stops all runtime work', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
    const loop = new RecordingSchedulerLoop(
      new InMemoryFeatureGraph(),
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

  it('creates a missing task run on first dispatch and starts it', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'ready',
          collabControl: 'none',
        },
      ],
    });
    const createAgentRun = vi.spyOn(ports.store, 'createAgentRun');
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const dispatchTask = vi.spyOn(runtime, 'dispatchTask');

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

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
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'running',
      owner: 'system',
      sessionId: 'sess-1',
      restartCount: 0,
    });
  });

  it('resumes an existing task run when session state is present', async () => {
    const order: string[] = [];
    const { ports, runtime } = createPorts(order);
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'ready',
          collabControl: 'none',
        },
      ],
    });
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(createAgentRun).not.toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: 'run-task:t-1',
        sessionId: 'sess-existing',
      },
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'ready',
          collabControl: 'none',
        },
      ],
    });
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(dispatchTask).toHaveBeenNthCalledWith(1, expect.anything(), {
      mode: 'resume',
      agentRunId: 'run-task:t-1',
      sessionId: 'sess-existing',
    });
    expect(dispatchTask).toHaveBeenNthCalledWith(2, expect.anything(), {
      mode: 'start',
      agentRunId: 'run-task:t-1',
    });
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'ready',
          collabControl: 'none',
        },
      ],
    });
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      { mode: 'start', agentRunId: 'run-task:t-1' },
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'ready',
          collabControl: 'none',
        },
        {
          id: 't-2',
          featureId: 'f-1',
          orderInFeature: 1,
          description: 'Task 2',
          dependsOn: [],
          status: 'ready',
          collabControl: 'none',
        },
      ],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(idleWorkerCount).toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      { mode: 'start', agentRunId: 'run-task:t-1' },
    );
  });

  it('completes a task run, marks the task merged, and advances the feature to feature_ci after the last task lands', async () => {
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
          workControl: 'executing',
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
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
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
        workControl: 'feature_ci',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-task:t-1', {
      runStatus: 'completed',
      owner: 'system',
      sessionId: 'sess-1',
    });
  });

  it('does not treat implicit worker exit as a landed task', async () => {
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
          workControl: 'executing',
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
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
        restartCount: 1,
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'worker_message',
      message: {
        type: 'error',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        error: 'provider overloaded',
      },
    });

    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'ready',
        collabControl: 'branch_open',
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith(
      'run-task:t-1',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
        retryAt: expect.any(Number),
      }),
    );
  });

  it('moves a task run to await_response manual ownership on request_help', async () => {
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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'worker_message',
      message: {
        type: 'request_help',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        query: 'what should I do?',
      },
    });

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
          workControl: 'executing',
          collabControl: 'none',
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
          status: 'running',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeTaskRun({
        id: 'run-task:t-1',
        runStatus: 'running',
        sessionId: 'sess-1',
      }),
    );
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(planFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      {
        agentRunId: 'run-feature:f-1:plan',
        sessionId: 'sess-existing',
      },
    );
  });

  it('dispatches feature_ci through the verification service before agent-level verifying', async () => {
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
          workControl: 'feature_ci',
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(verifyFeatureBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
    );
  });

  it('moves feature_ci into retry_await when the verification service throws', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    vi.spyOn(ports.verification, 'verifyFeature').mockRejectedValueOnce(
      new Error('feature checks failed to run'),
    );
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
          status: 'pending',
          workControl: 'feature_ci',
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(updateAgentRun).toHaveBeenCalledWith(
      'run-feature:f-1:feature_ci',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
        retryAt: expect.any(Number),
      }),
    );
  });

  it('dispatches verify feature phases through the agent port', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const verifyFeature = vi.spyOn(ports.agents, 'verifyFeature');
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
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(verifyFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      { agentRunId: 'run-feature:f-1:verify' },
    );
  });

  it('dispatches summarize feature phases after merge in non-budget mode', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order, { tokenProfile: 'balanced' });
    const summarizeFeature = vi.spyOn(ports.agents, 'summarizeFeature');
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
          status: 'done',
          workControl: 'awaiting_merge',
          collabControl: 'merged',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.tickForTest(100);

    expect(summarizeFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-1' }),
      { agentRunId: 'run-feature:f-1:summarize' },
    );
  });

  it('does not emit feature_phase_complete when plan submits proposal for approval', async () => {
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ObservingSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(loop.handledEvents).toEqual([]);
  });

  it('enqueues feature_phase_error after failed feature-phase work', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    vi.spyOn(ports.agents, 'planFeature').mockRejectedValueOnce(
      new Error('boom'),
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
          status: 'pending',
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ObservingSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(planFeature).not.toHaveBeenCalled();
  });

  it('approves planning proposal, applies ops, readies root tasks, and completes run', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing',
        status: 'pending',
        collabControl: 'none',
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
      }),
    );
  });

  it('rejects planning proposal, leaves graph unchanged, blocks auto-redispatch, and allows explicit rerun', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
    const updateAgentRun = vi.spyOn(ports.store, 'updateAgentRun');
    const appendEvent = vi.spyOn(ports.store, 'appendEvent');
    const planFeature = vi.spyOn(ports.agents, 'planFeature');
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'rejected',
      comment: 'not now',
    });

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
      payloadJson: JSON.stringify(makeProposal('plan')),
    });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proposal_rejected',
        entityId: 'f-1',
      }),
    );

    planFeature.mockClear();
    await loop.dispatchReadyWorkForTest(100);
    expect(planFeature).not.toHaveBeenCalled();

    await loop.handleEventForTest({
      type: 'feature_phase_rerun_requested',
      featureId: 'f-1',
      phase: 'plan',
    });
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:plan', {
      runStatus: 'ready',
      owner: 'system',
    });

    planFeature.mockClear();
    await loop.dispatchReadyWorkForTest(100);
    expect(planFeature).toHaveBeenCalledOnce();
  });

  it('approves replanning proposal, restores stuck task, and makes approved work executable immediately', async () => {
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
          workControl: 'replanning',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-stuck',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Existing stuck task',
          dependsOn: [],
          status: 'stuck',
          collabControl: 'branch_open',
        },
      ],
    });
    ports.store.createAgentRun(
      makeFeaturePhaseRun('replan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(makeProposal('replan')),
      }),
    );

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'replan',
      decision: 'approved',
    });

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
  });

  it('records proposal_apply_failed when approval payload is invalid', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(
      makeFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: '{bad-json',
      }),
    );

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });

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
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proposal_apply_failed',
        entityId: 'f-1',
        payload: expect.objectContaining({
          phase: 'plan',
          error: expect.stringContaining('JSON'),
        }),
      }),
    );
  });

  it('keeps feature in planning when approved proposal applies no ops', async () => {
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });

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

  it('records proposal_apply_failed when proposal op shape is invalid', async () => {
    const order: string[] = [];
    const { ports } = createPorts(order);
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'plan',
      decision: 'approved',
    });

    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'proposal_apply_failed',
        entityId: 'f-1',
        payload: expect.objectContaining({
          phase: 'plan',
          error: 'invalid proposal payload',
        }),
      }),
    );
  });

  it('moves feature_ci success into verifying', async () => {
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
          workControl: 'feature_ci',
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
    ports.store.createAgentRun(makeFeaturePhaseRun('feature_ci'));

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'feature_ci',
      summary: 'green',
      verification: { ok: true, summary: 'green' },
    });

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'verifying',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:feature_ci', {
      runStatus: 'completed',
      owner: 'system',
    });
  });

  it('moves verify success to awaiting_merge and merge_queued', async () => {
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'verified',
      verification: { ok: true, summary: 'verified' },
    });

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'awaiting_merge',
        status: 'pending',
        collabControl: 'merge_queued',
        mergeTrainEntrySeq: 1,
      }),
    );
    expect(updateAgentRun).toHaveBeenCalledWith('run-feature:f-1:verify', {
      runStatus: 'completed',
      owner: 'system',
    });
  });

  it('moves feature_ci failure into executing_repair and creates a ready repair task', async () => {
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
          workControl: 'feature_ci',
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
    ports.store.createAgentRun(makeFeaturePhaseRun('feature_ci'));

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'feature_ci',
      summary: 'tests failed',
      verification: { ok: false, summary: 'tests failed' },
    });

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
    expect(repairTasks[0]).toEqual(
      expect.objectContaining({
        status: 'ready',
        collabControl: 'none',
        description: expect.stringContaining('Repair feature ci issues'),
        repairSource: 'feature_ci',
      }),
    );
  });

  it('moves verify failure into executing_repair and creates a ready repair task', async () => {
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'failed checks',
      verification: { ok: false, summary: 'failed checks' },
    });

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing_repair',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    const repairTasks = [...graph.tasks.values()];
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toEqual(
      expect.objectContaining({
        status: 'ready',
        description: expect.stringContaining(
          'Repair feature verification issues',
        ),
        repairSource: 'verify',
      }),
    );
  });

  it('does not count ordinary repair-named tasks as repair attempts', async () => {
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'failed checks',
      verification: { ok: false, summary: 'failed checks' },
    });

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing_repair',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    const repairTasks = [...graph.tasks.values()].filter(
      (task) => task.repairSource !== undefined,
    );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toEqual(
      expect.objectContaining({
        repairSource: 'verify',
        description: expect.stringContaining(
          'Repair feature verification issues',
        ),
      }),
    );
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'verify',
      summary: 'failed again',
      verification: { ok: false, summary: 'failed again' },
    });

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'replanning',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect([...graph.tasks.values()]).toHaveLength(1);
  });

  it('rejects feature_ci completion when verification payload is missing', async () => {
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
          workControl: 'feature_ci',
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
    ports.store.createAgentRun(makeFeaturePhaseRun('feature_ci'));

    const loop = new ExposedSchedulerLoop(graph, ports);

    await expect(
      loop.handleEventForTest({
        type: 'feature_phase_complete',
        featureId: 'f-1',
        phase: 'feature_ci',
        summary: 'green',
      }),
    ).rejects.toThrow('feature_ci completion requires verification summary');
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await expect(
      loop.handleEventForTest({
        type: 'feature_phase_complete',
        featureId: 'f-1',
        phase: 'verify',
        summary: 'verified',
      }),
    ).rejects.toThrow('verify completion requires verification summary');
  });

  it('does not rerun feature_ci while a repair task remains incomplete', async () => {
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.tickForTest(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing_repair',
        collabControl: 'branch_open',
      }),
    );
    expect(verifyFeatureBranch).not.toHaveBeenCalled();
  });

  it('returns executing_repair to feature_ci after the repair task lands', async () => {
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
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

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'feature_ci',
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
          status: 'done',
          workControl: 'awaiting_merge',
          collabControl: 'merged',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.tickForTest(100);

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
          status: 'done',
          workControl: 'awaiting_merge',
          collabControl: 'merged',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.tickForTest(100);

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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_complete',
      featureId: 'f-1',
      phase: 'summarize',
      summary: 'final summary',
    });

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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await expect(
      loop.handleEventForTest({
        type: 'feature_phase_complete',
        featureId: 'f-1',
        phase: 'summarize',
        summary: '',
      }),
    ).rejects.toThrow('summarize completion requires summary text');
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.tickForTest(100);

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

    const loop = new ExposedSchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_complete',
      featureId: 'f-1',
    });

    await loop.tickForTest(100);

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

    const loop = new ExposedSchedulerLoop(graph, ports);
    loop.enqueue({
      type: 'feature_integration_failed',
      featureId: 'f-1',
      error: 'rebase failed',
    });

    await loop.tickForTest(100);

    const failedFeature = graph.features.get('f-1');
    expect(failedFeature).toBeDefined();
    expect(failedFeature).toEqual(
      expect.objectContaining({
        collabControl: 'conflict',
        workControl: 'awaiting_merge',
        status: 'in_progress',
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

  it('puts feature-phase errors into retry_await on the shared run plane', async () => {
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
          workControl: 'planning',
          collabControl: 'none',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    ports.store.createAgentRun(makeFeaturePhaseRun('plan'));

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.handleEventForTest({
      type: 'feature_phase_error',
      featureId: 'f-1',
      phase: 'plan',
      error: 'boom',
    });

    expect(updateAgentRun).toHaveBeenCalledWith(
      'run-feature:f-1:plan',
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
        retryAt: expect.any(Number),
      }),
    );
  });
});
