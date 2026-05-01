import type {
  AgentRun,
  EventRecord,
  TaskAgentRun,
  TokenUsageAggregate,
} from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { SqliteStore } from '@persistence/sqlite-store';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOKEN_USAGE: TokenUsageAggregate = {
  llmCalls: 2,
  inputTokens: 800,
  outputTokens: 400,
  cacheReadTokens: 150,
  cacheWriteTokens: 75,
  reasoningTokens: 25,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  totalTokens: 1450,
  usd: 0.0085,
  byModel: {
    'anthropic:claude-opus-4-6': {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      llmCalls: 2,
      inputTokens: 800,
      outputTokens: 400,
      cacheReadTokens: 150,
      cacheWriteTokens: 75,
      reasoningTokens: 25,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      totalTokens: 1450,
      usd: 0.0085,
    },
  },
};

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

describe('SqliteStore', () => {
  let db: Database.Database;
  let store: SqliteStore;
  let clock = 1_000_000;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 1_000_000;
    db = openDatabase(':memory:');
    store = new SqliteStore(db, now);
  });

  afterEach(() => {
    db.close();
  });

  describe('agent runs', () => {
    it('returns undefined for a missing run', () => {
      expect(store.getAgentRun('run-missing')).toBeUndefined();
    });

    it('round-trips a task-scoped run', () => {
      const run = makeTaskRun({
        sessionId: 'sess-abc',
        payloadJson: JSON.stringify({ hint: 'retry later' }),
        retryAt: 42,
      });
      store.createAgentRun(run);

      const loaded = store.getAgentRun(run.id);
      expect(loaded).toEqual(run);
    });

    it('round-trips a feature-phase run', () => {
      const run: AgentRun = {
        id: 'run-feat-1',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'discuss',
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
        restartCount: 0,
        maxRetries: 0,
      };
      store.createAgentRun(run);

      expect(store.getAgentRun(run.id)).toEqual(run);
    });

    it('round-trips a feature-phase proposal payload in payloadJson', () => {
      const payloadJson = JSON.stringify({
        version: 1,
        mode: 'plan',
        aliases: { '#1': 'f-new' },
        ops: [
          {
            kind: 'add_feature',
            featureId: 'f-new',
            milestoneId: 'm-1',
            name: 'New feature',
            description: 'draft',
          },
        ],
      });
      const run: AgentRun = {
        id: 'run-feat-plan-1',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'plan',
        runStatus: 'await_approval',
        owner: 'manual',
        attention: 'none',
        restartCount: 0,
        maxRetries: 3,
        payloadJson,
      };
      store.createAgentRun(run);

      expect(store.getAgentRun(run.id)).toEqual(run);
    });

    it('updates fields via updateAgentRun', () => {
      const run = makeTaskRun();
      store.createAgentRun(run);

      store.updateAgentRun(run.id, {
        runStatus: 'running',
        sessionId: 'sess-xyz',
      });

      const loaded = store.getAgentRun(run.id);
      expect(loaded?.runStatus).toBe('running');
      expect(loaded?.sessionId).toBe('sess-xyz');
    });

    it('round-trips tokenUsage on agent runs', () => {
      const run = {
        ...makeTaskRun(),
        tokenUsage: TOKEN_USAGE,
      } as TaskAgentRun;
      store.createAgentRun(run);

      const loaded = store.getAgentRun(run.id);
      expect(loaded).toMatchObject({ ...run, tokenUsage: TOKEN_USAGE });

      const row = db
        .prepare<[string], { token_usage: string | null }>(
          'SELECT token_usage FROM agent_runs WHERE id = ?',
        )
        .get(run.id);
      expect(row?.token_usage).toContain('llmCalls');
    });

    it('updateAgentRun preserves created_at and advances updated_at', () => {
      clock = 1_000;
      const run = makeTaskRun();
      store.createAgentRun(run);

      clock = 5_000;
      store.updateAgentRun(run.id, { runStatus: 'running' });

      const row = db
        .prepare<[string], { created_at: number; updated_at: number }>(
          'SELECT created_at, updated_at FROM agent_runs WHERE id = ?',
        )
        .get(run.id);
      expect(row?.created_at).toBe(1_000);
      expect(row?.updated_at).toBe(5_000);
    });

    it('updates tokenUsage via updateAgentRun', () => {
      const run = makeTaskRun();
      store.createAgentRun(run);

      store.updateAgentRun(run.id, {
        tokenUsage: TOKEN_USAGE,
      } as Partial<AgentRun>);

      const loaded = store.getAgentRun(run.id);
      expect(loaded).toMatchObject({ ...run, tokenUsage: TOKEN_USAGE });
    });

    it('persists trailerObservedAt through the store round-trip', () => {
      const run = makeTaskRun();
      store.createAgentRun(run);

      expect(store.getTrailerObservedAt(run.id)).toBeUndefined();

      store.setTrailerObservedAt(run.id, 1234);
      store.setTrailerObservedAt(run.id, 5678);

      expect(store.getTrailerObservedAt(run.id)).toBe(1234);
      expect(store.getAgentRun(run.id)).toEqual({
        ...run,
        trailerObservedAt: 1234,
      });

      const row = db
        .prepare<[string], { trailer_observed_at: number | null }>(
          'SELECT trailer_observed_at FROM agent_runs WHERE id = ?',
        )
        .get(run.id);
      expect(row?.trailer_observed_at).toBe(1234);
    });

    it('updateAgentRun throws on missing run without touching any row', () => {
      const run = makeTaskRun();
      store.createAgentRun(run);

      expect(() =>
        store.updateAgentRun('run-missing', { runStatus: 'running' }),
      ).toThrow();

      // Existing run is unchanged.
      expect(store.getAgentRun(run.id)?.runStatus).toBe('ready');
    });

    it('filters listAgentRuns by query fields', () => {
      store.createAgentRun(makeTaskRun({ id: 'r1', runStatus: 'ready' }));
      store.createAgentRun(makeTaskRun({ id: 'r2', runStatus: 'running' }));
      store.createAgentRun(
        makeTaskRun({ id: 'r3', runStatus: 'running', owner: 'manual' }),
      );

      expect(store.listAgentRuns({ runStatus: 'running' })).toHaveLength(2);
      expect(store.listAgentRuns({ owner: 'manual' })).toHaveLength(1);
      expect(store.listAgentRuns()).toHaveLength(3);
    });
  });

  describe('events', () => {
    it('appends and lists events in insertion order', () => {
      const e1: EventRecord = {
        eventType: 'budget_warning',
        entityId: 'f-1',
        timestamp: 100,
        payload: { percent: 80 },
      };
      const e2: EventRecord = {
        eventType: 'task_failed',
        entityId: 't-1',
        timestamp: 200,
      };
      store.appendEvent(e1);
      store.appendEvent(e2);

      const all = store.listEvents();
      expect(all).toEqual([e1, e2]);
    });

    it('filters events by eventType', () => {
      store.appendEvent({
        eventType: 'budget_warning',
        entityId: 'f-1',
        timestamp: 100,
      });
      store.appendEvent({
        eventType: 'task_failed',
        entityId: 't-1',
        timestamp: 200,
      });

      const filtered = store.listEvents({ eventType: 'task_failed' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.entityId).toBe('t-1');
    });

    it('filters events by timestamp range', () => {
      store.appendEvent({
        eventType: 'x',
        entityId: 'e',
        timestamp: 100,
      });
      store.appendEvent({
        eventType: 'x',
        entityId: 'e',
        timestamp: 200,
      });
      store.appendEvent({
        eventType: 'x',
        entityId: 'e',
        timestamp: 300,
      });

      expect(store.listEvents({ since: 150 })).toHaveLength(2);
      expect(store.listEvents({ until: 200 })).toHaveLength(2);
      expect(store.listEvents({ since: 150, until: 250 })).toHaveLength(1);
    });
  });

  describe('inbox items', () => {
    it('lists unresolved inbox items with query filters in descending time order', () => {
      store.appendInboxItem({
        id: 'inbox-1',
        ts: 100,
        taskId: 't-1',
        agentRunId: 'run-1',
        featureId: 'f-1',
        kind: 'agent_help',
        payload: { query: 'Need input' },
      });
      store.appendInboxItem({
        id: 'inbox-2',
        ts: 200,
        taskId: 't-2',
        agentRunId: 'run-2',
        featureId: 'f-1',
        kind: 'agent_approval',
        payload: { kind: 'custom', label: 'Approve', detail: 'Ship it' },
      });
      store.resolveInboxItem('inbox-1', {
        kind: 'answered',
        resolvedAt: 300,
        note: 'Done',
      });

      expect(store.listInboxItems().map((item) => item.id)).toEqual([
        'inbox-2',
        'inbox-1',
      ]);
      expect(
        store.listInboxItems({ unresolvedOnly: true }).map((item) => item.id),
      ).toEqual(['inbox-2']);
      expect(store.listInboxItems({ kind: 'agent_help' })).toHaveLength(1);
      expect(store.listInboxItems({ taskId: 't-2' })).toHaveLength(1);
      expect(store.listInboxItems({ agentRunId: 'run-2' })).toHaveLength(1);
      expect(store.listInboxItems({ featureId: 'f-1' })).toHaveLength(2);
    });

    it('round-trips payload and resolution JSON for inbox items', () => {
      store.appendInboxItem({
        id: 'inbox-1',
        ts: 100,
        taskId: 't-1',
        agentRunId: 'run-1',
        featureId: 'f-1',
        kind: 'agent_approval',
        payload: {
          kind: 'replan_proposal',
          summary: 'Replan this',
          proposedMutations: ['add task', 'drop task'],
        },
      });
      store.resolveInboxItem('inbox-1', {
        kind: 'approved',
        resolvedAt: 200,
        note: 'Looks good',
        fanoutTaskIds: ['t-1', 't-9'],
      });

      expect(store.listInboxItems()).toEqual([
        {
          id: 'inbox-1',
          ts: 100,
          taskId: 't-1',
          agentRunId: 'run-1',
          featureId: 'f-1',
          kind: 'agent_approval',
          payload: {
            kind: 'replan_proposal',
            summary: 'Replan this',
            proposedMutations: ['add task', 'drop task'],
          },
          resolution: {
            kind: 'approved',
            resolvedAt: 200,
            note: 'Looks good',
            fanoutTaskIds: ['t-1', 't-9'],
          },
        },
      ]);

      const row = db
        .prepare<[string], { payload: string; resolution: string | null }>(
          'SELECT payload, resolution FROM inbox_items WHERE id = ?',
        )
        .get('inbox-1');
      expect(row?.payload).toContain('replan_proposal');
      expect(row?.resolution).toContain('fanoutTaskIds');
    });
  });
});
