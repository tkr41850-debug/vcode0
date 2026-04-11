import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRun,
  EventRecord,
  FeaturePhaseAgentRun,
  TaskAgentRun,
  TokenUsageAggregate,
} from '@core/types/index';
import type {
  DependencyEdge,
  StoreGraphState,
} from '@orchestrator/ports/index';
import { SqliteStore } from '@persistence/sqlite';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function createTokenUsageFixture(model: string): TokenUsageAggregate {
  return {
    llmCalls: 2,
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    reasoningTokens: 5,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens: 200,
    usd: 1.25,
    byModel: {
      [model]: {
        provider: 'anthropic',
        model,
        llmCalls: 2,
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        totalTokens: 200,
        usd: 1.25,
      },
    },
  };
}

function createTaskRunFixture(
  overrides: Partial<TaskAgentRun> = {},
): TaskAgentRun {
  return {
    id: 'run-task-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 1,
    ...overrides,
  };
}

function createFeaturePhaseRunFixture(
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: 'run-feature-1',
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase: 'plan',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 0,
    ...overrides,
  };
}

function createEventFixture(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventType: 'task.updated',
    entityId: 't-1',
    timestamp: 100,
    payload: { status: 'running' },
    ...overrides,
  };
}

function normalize<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortById<T extends { id: string }>(values: T[]): T[] {
  return [...values].sort((a, b) => a.id.localeCompare(b.id));
}

function sortAgentRuns(runs: AgentRun[]): AgentRun[] {
  return [...runs].sort((a, b) => a.id.localeCompare(b.id));
}

function sortDependencies(edges: DependencyEdge[]): DependencyEdge[] {
  return [...edges].sort((a, b) => {
    const left = `${a.depType}:${a.fromId}:${a.toId}`;
    const right = `${b.depType}:${b.fromId}:${b.toId}`;
    return left.localeCompare(right);
  });
}

async function withTestStore(
  run: (store: SqliteStore) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'gvc0-sqlite-'));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await run(new SqliteStore());
  } finally {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('SqliteStore', () => {
  it('persists graph state through getters, listers, and recovery loading', async () => {
    await withTestStore(async (store) => {
      const milestone = createMilestoneFixture({
        id: 'm-10',
        name: 'Persistence',
        description: 'Store durable graph state',
        status: 'in_progress',
        order: 3,
        steeringQueuePosition: 2,
      });
      const feature = createFeatureFixture({
        id: 'f-10',
        milestoneId: 'm-10',
        orderInMilestone: 4,
        name: 'Implement SQLite store',
        description: 'Persist graph state in SQLite',
        status: 'in_progress',
        workControl: 'awaiting_merge',
        collabControl: 'merge_queued',
        featureBranch: 'feat-f-10',
        featureTestPolicy: 'strict',
        mergeTrainManualPosition: 7,
        mergeTrainEnteredAt: 1_710_000_000,
        mergeTrainEntrySeq: 11,
        mergeTrainReentryCount: 2,
        tokenUsage: createTokenUsageFixture('claude-sonnet-4-6'),
      });
      const task = createTaskFixture({
        id: 't-10',
        featureId: 'f-10',
        orderInFeature: 5,
        description: 'Write SQLite contract tests',
        status: 'running',
        collabControl: 'suspended',
        weight: 'heavy',
        workerId: 'worker-10',
        worktreeBranch: 'feat-f-10-task-t-10',
        reservedWritePaths: [
          'src/persistence/sqlite.ts',
          'test/unit/persistence/sqlite.test.ts',
        ],
        result: {
          summary: 'Added contract coverage for store persistence',
          filesChanged: [
            'src/persistence/sqlite.ts',
            'test/unit/persistence/sqlite.test.ts',
          ],
        },
        tokenUsage: createTokenUsageFixture('claude-opus-4-6'),
        taskTestPolicy: 'strict',
        sessionId: 'session-task-10',
        consecutiveFailures: 3,
        suspendedAt: 1_710_000_100,
        suspendReason: 'same_feature_overlap',
        suspendedFiles: ['src/persistence/sqlite.ts'],
      });
      const graphState: StoreGraphState = {
        milestones: [milestone],
        features: [feature],
        tasks: [task],
      };

      await store.saveGraphState(graphState);

      expect(normalize(await store.getMilestone('m-10'))).toEqual(
        normalize(milestone),
      );
      expect(normalize(await store.getFeature('f-10'))).toEqual(
        normalize(feature),
      );
      expect(normalize(await store.getTask('t-10'))).toEqual(normalize(task));
      expect(normalize(await store.listMilestones())).toEqual(
        normalize([milestone]),
      );
      expect(normalize(await store.listFeatures())).toEqual(
        normalize([feature]),
      );
      expect(normalize(await store.listTasks())).toEqual(normalize([task]));

      const recovery = await store.loadRecoveryState();
      expect(normalize(sortById(recovery.milestones))).toEqual(
        normalize([milestone]),
      );
      expect(normalize(sortById(recovery.features))).toEqual(
        normalize([feature]),
      );
      expect(normalize(sortById(recovery.tasks))).toEqual(normalize([task]));
      expect(recovery.agentRuns).toEqual([]);
      expect(recovery.dependencies).toEqual([]);
    });
  });

  it('persists agent runs and filters them by the Store query contract', async () => {
    await withTestStore(async (store) => {
      const taskRun = createTaskRunFixture({
        id: 'run-task-10',
        scopeId: 't-10',
        runStatus: 'running',
        sessionId: 'session-task-10-a',
        payloadJson: JSON.stringify({ attempt: 1 }),
        restartCount: 1,
        maxRetries: 3,
        retryAt: 200,
      });
      const featureRun = createFeaturePhaseRunFixture({
        id: 'run-feature-10',
        scopeId: 'f-10',
        phase: 'plan',
        runStatus: 'ready',
        owner: 'system',
        attention: 'none',
        sessionId: 'session-feature-10',
        payloadJson: JSON.stringify({ step: 'outline' }),
      });

      await store.createAgentRun(taskRun);
      await store.createAgentRun(featureRun);

      const taskRunPatch = {
        runStatus: 'await_response',
        owner: 'manual',
        attention: 'crashloop_backoff',
        sessionId: 'session-task-10-b',
        payloadJson: JSON.stringify({ question: 'Need approval' }),
        restartCount: 2,
        maxRetries: 4,
        retryAt: 500,
      } as const;
      const updatedTaskRun: TaskAgentRun = {
        ...taskRun,
        ...taskRunPatch,
      };

      await store.updateAgentRun(taskRun.id, taskRunPatch);

      expect(normalize(await store.getAgentRun(taskRun.id))).toEqual(
        normalize(updatedTaskRun),
      );
      expect(
        normalize(
          await store.listAgentRuns({
            scopeType: 'task',
            scopeId: 't-10',
            phase: 'execute',
            runStatus: 'await_response',
            owner: 'manual',
          }),
        ),
      ).toEqual(normalize([updatedTaskRun]));
      expect(
        normalize(
          await store.listAgentRuns({
            scopeType: 'feature_phase',
            scopeId: 'f-10',
            phase: 'plan',
            runStatus: 'ready',
            owner: 'system',
          }),
        ),
      ).toEqual(normalize([featureRun]));

      const recovery = await store.loadRecoveryState();
      expect(recovery.milestones).toEqual([]);
      expect(recovery.features).toEqual([]);
      expect(recovery.tasks).toEqual([]);
      expect(normalize(sortAgentRuns(recovery.agentRuns))).toEqual(
        normalize(sortAgentRuns([updatedTaskRun, featureRun])),
      );
      expect(recovery.dependencies).toEqual([]);
    });
  });

  it('persists dependency edges and supports removing them', async () => {
    await withTestStore(async (store) => {
      const featureEdge = {
        depType: 'feature',
        fromId: 'f-2',
        toId: 'f-1',
      } satisfies DependencyEdge;
      const taskEdge = {
        depType: 'task',
        fromId: 't-2',
        toId: 't-1',
      } satisfies DependencyEdge;

      await store.saveDependency(featureEdge);
      await store.saveDependency(taskEdge);

      expect(
        normalize(sortDependencies(await store.listDependencies())),
      ).toEqual(normalize(sortDependencies([featureEdge, taskEdge])));

      await store.removeDependency(featureEdge);

      expect(normalize(await store.listDependencies())).toEqual(
        normalize([taskEdge]),
      );
    });
  });

  it('appends events and filters them by type, entity, and time range', async () => {
    await withTestStore(async (store) => {
      const started = createEventFixture({
        eventType: 'task.started',
        entityId: 't-10',
        timestamp: 100,
        payload: { status: 'running' },
      });
      const warning = createEventFixture({
        eventType: 'feature.warning',
        entityId: 'f-10',
        timestamp: 200,
        payload: { category: 'budget_pressure' },
      });
      const completed = createEventFixture({
        eventType: 'task.completed',
        entityId: 't-10',
        timestamp: 300,
        payload: { status: 'done' },
      });

      await store.appendEvent(started);
      await store.appendEvent(warning);
      await store.appendEvent(completed);

      expect(normalize(await store.listEvents())).toEqual(
        normalize([started, warning, completed]),
      );
      expect(
        normalize(await store.listEvents({ eventType: 'feature.warning' })),
      ).toEqual(normalize([warning]));
      expect(
        normalize(
          await store.listEvents({
            entityId: 't-10',
            since: 250,
            until: 350,
          }),
        ),
      ).toEqual(normalize([completed]));
    });
  });

  it('replaces authoritative graph rows without erasing runs, dependencies, or events', async () => {
    await withTestStore(async (store) => {
      const initialGraph: StoreGraphState = {
        milestones: [
          createMilestoneFixture({ id: 'm-1', name: 'Primary', order: 0 }),
          createMilestoneFixture({ id: 'm-stale', name: 'Stale', order: 1 }),
        ],
        features: [
          createFeatureFixture({
            id: 'f-anchor',
            milestoneId: 'm-1',
            name: 'Anchor',
            featureBranch: 'feat-f-anchor',
          }),
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            name: 'Current',
            featureBranch: 'feat-f-1',
          }),
          createFeatureFixture({
            id: 'f-stale',
            milestoneId: 'm-stale',
            name: 'Legacy',
            featureBranch: 'feat-f-stale',
          }),
        ],
        tasks: [
          createTaskFixture({
            id: 't-anchor',
            featureId: 'f-anchor',
            description: 'Anchor task',
          }),
          createTaskFixture({
            id: 't-1',
            featureId: 'f-1',
            description: 'Current task',
          }),
          createTaskFixture({
            id: 't-stale',
            featureId: 'f-stale',
            description: 'Legacy task',
          }),
        ],
      };
      const replacementGraph: StoreGraphState = {
        milestones: [
          createMilestoneFixture({
            id: 'm-1',
            name: 'Primary updated',
            description: 'Replacement graph snapshot',
            status: 'done',
            order: 9,
            steeringQueuePosition: 1,
          }),
        ],
        features: [
          createFeatureFixture({
            id: 'f-anchor',
            milestoneId: 'm-1',
            orderInMilestone: 1,
            name: 'Anchor updated',
            description: 'Still present after replacement',
            status: 'done',
            workControl: 'work_complete',
            collabControl: 'merged',
            featureBranch: 'feat-f-anchor',
          }),
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            orderInMilestone: 2,
            name: 'Current updated',
            description: 'The surviving feature row',
            dependsOn: ['f-anchor'],
            status: 'in_progress',
            workControl: 'executing',
            collabControl: 'branch_open',
            featureBranch: 'feat-f-1',
          }),
        ],
        tasks: [
          createTaskFixture({
            id: 't-anchor',
            featureId: 'f-anchor',
            orderInFeature: 1,
            description: 'Anchor task updated',
            status: 'done',
            collabControl: 'merged',
          }),
          createTaskFixture({
            id: 't-1',
            featureId: 'f-1',
            orderInFeature: 2,
            description: 'Current task updated',
            dependsOn: ['t-anchor'],
            status: 'ready',
            collabControl: 'branch_open',
          }),
        ],
      };
      const taskRun = createTaskRunFixture({
        id: 'run-task-1',
        scopeId: 't-1',
        runStatus: 'await_response',
        owner: 'manual',
      });
      const featureEdge = {
        depType: 'feature',
        fromId: 'f-1',
        toId: 'f-anchor',
      } satisfies DependencyEdge;
      const taskEdge = {
        depType: 'task',
        fromId: 't-1',
        toId: 't-anchor',
      } satisfies DependencyEdge;
      const event = createEventFixture({
        eventType: 'scheduler.tick',
        entityId: 'global',
        timestamp: 500,
        payload: { frontierSize: 2 },
      });

      await store.saveGraphState(initialGraph);
      await store.createAgentRun(taskRun);
      await store.saveDependency(featureEdge);
      await store.saveDependency(taskEdge);
      await store.appendEvent(event);
      await store.saveGraphState(replacementGraph);

      expect(await store.getMilestone('m-stale')).toBeUndefined();
      expect(await store.getFeature('f-stale')).toBeUndefined();
      expect(await store.getTask('t-stale')).toBeUndefined();
      expect(normalize(await store.listMilestones())).toEqual(
        normalize(replacementGraph.milestones),
      );
      expect(normalize(sortById(await store.listFeatures()))).toEqual(
        normalize(sortById(replacementGraph.features)),
      );
      expect(normalize(sortById(await store.listTasks()))).toEqual(
        normalize(sortById(replacementGraph.tasks)),
      );
      expect(normalize(await store.getAgentRun(taskRun.id))).toEqual(
        normalize(taskRun),
      );
      expect(
        normalize(sortDependencies(await store.listDependencies())),
      ).toEqual(normalize(sortDependencies([featureEdge, taskEdge])));
      expect(normalize(await store.listEvents())).toEqual(normalize([event]));

      const recovery = await store.loadRecoveryState();
      expect(normalize(recovery.milestones)).toEqual(
        normalize(replacementGraph.milestones),
      );
      expect(normalize(sortById(recovery.features))).toEqual(
        normalize(sortById(replacementGraph.features)),
      );
      expect(normalize(sortById(recovery.tasks))).toEqual(
        normalize(sortById(replacementGraph.tasks)),
      );
      expect(normalize(recovery.agentRuns)).toEqual(normalize([taskRun]));
      expect(normalize(sortDependencies(recovery.dependencies))).toEqual(
        normalize(sortDependencies([featureEdge, taskEdge])),
      );
    });
  });

  it('close() prevents further database operations', async () => {
    await withTestStore(async (store) => {
      await store.saveGraphState({
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [],
        tasks: [],
      });
      store.close();
      // After close, the underlying db handle is dead — any operation should throw
      await expect(store.listMilestones()).rejects.toThrow();
    });
  });

  it('updateMilestone patches individual fields', async () => {
    await withTestStore(async (store) => {
      const milestone = createMilestoneFixture({
        id: 'm-1',
        name: 'Original',
        status: 'pending',
        order: 0,
      });
      await store.saveGraphState({
        milestones: [milestone],
        features: [],
        tasks: [],
      });

      await store.updateMilestone('m-1', { name: 'Updated', status: 'done' });

      const result = await store.getMilestone('m-1');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Updated');
      expect(result!.status).toBe('done');
      // Unpatched fields remain
      expect(result!.order).toBe(0);
    });
  });

  it('updateMilestone with empty patch is a no-op', async () => {
    await withTestStore(async (store) => {
      const milestone = createMilestoneFixture({ id: 'm-1', name: 'Orig' });
      await store.saveGraphState({
        milestones: [milestone],
        features: [],
        tasks: [],
      });

      await store.updateMilestone('m-1', {});

      const result = await store.getMilestone('m-1');
      expect(result!.name).toBe('Orig');
    });
  });

  it('updateFeature patches individual fields', async () => {
    await withTestStore(async (store) => {
      const feature = createFeatureFixture({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Original',
        featureBranch: 'feat-f-1',
        orderInMilestone: 1,
      });
      await store.saveGraphState({
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [feature],
        tasks: [],
      });

      await store.updateFeature('f-1', {
        name: 'Updated',
        featureBranch: 'feat-f-1-v2',
        mergeTrainManualPosition: 5,
      });

      const result = await store.getFeature('f-1');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Updated');
      expect(result!.featureBranch).toBe('feat-f-1-v2');
      expect(result!.mergeTrainManualPosition).toBe(5);
      // Unpatched fields remain
      expect(result!.orderInMilestone).toBe(1);
    });
  });

  it('updateFeature with empty patch is a no-op', async () => {
    await withTestStore(async (store) => {
      const feature = createFeatureFixture({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'Orig',
        featureBranch: 'feat-f-1',
      });
      await store.saveGraphState({
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [feature],
        tasks: [],
      });

      await store.updateFeature('f-1', {});

      const result = await store.getFeature('f-1');
      expect(result!.name).toBe('Orig');
    });
  });

  it('updateTask patches individual fields', async () => {
    await withTestStore(async (store) => {
      const task = createTaskFixture({
        id: 't-1',
        featureId: 'f-1',
        description: 'Original',
        weight: 'small',
        orderInFeature: 1,
      });
      await store.saveGraphState({
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            featureBranch: 'feat-f-1',
          }),
        ],
        tasks: [task],
      });

      await store.updateTask('t-1', {
        description: 'Updated',
        weight: 'heavy',
        workerId: 'worker-99',
      });

      const result = await store.getTask('t-1');
      expect(result).toBeDefined();
      expect(result!.description).toBe('Updated');
      expect(result!.weight).toBe('heavy');
      expect(result!.workerId).toBe('worker-99');
      // Unpatched fields remain
      expect(result!.orderInFeature).toBe(1);
    });
  });

  it('updateTask with empty patch is a no-op', async () => {
    await withTestStore(async (store) => {
      const task = createTaskFixture({
        id: 't-1',
        featureId: 'f-1',
        description: 'Orig',
      });
      await store.saveGraphState({
        milestones: [createMilestoneFixture({ id: 'm-1' })],
        features: [
          createFeatureFixture({
            id: 'f-1',
            milestoneId: 'm-1',
            featureBranch: 'feat-f-1',
          }),
        ],
        tasks: [task],
      });

      await store.updateTask('t-1', {});

      const result = await store.getTask('t-1');
      expect(result!.description).toBe('Orig');
    });
  });
});
