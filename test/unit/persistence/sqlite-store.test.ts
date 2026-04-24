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

  describe('integration marker', () => {
    beforeEach(() => {
      // Marker row references features(id); seed one row so the FK satisfies.
      db.prepare(
        `INSERT INTO milestones (id, name, display_order, status, created_at, updated_at)
         VALUES ('m-1', 'M1', 0, 'pending', 0, 0)`,
      ).run();
      db.prepare(
        `INSERT INTO features
           (id, milestone_id, order_in_milestone, name, status, work_phase,
            collab_status, feature_branch, merge_train_reentry_count,
            created_at, updated_at)
         VALUES ('f-1', 'm-1', 0, 'Feat', 'pending', 'awaiting_merge',
                 'integrating', 'feat-f-1', 0, 0, 0)`,
      ).run();
    });

    it('returns undefined when no marker exists', () => {
      expect(store.getIntegrationState()).toBeUndefined();
    });

    it('writes and reads the marker row', () => {
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        configSnapshot: '{"verification":{}}',
        intent: 'integrate',
        startedAt: 12345,
      });

      expect(store.getIntegrationState()).toEqual({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        configSnapshot: '{"verification":{}}',
        intent: 'integrate',
        startedAt: 12345,
      });
    });

    it('upserts existing marker in place (singleton invariant)', () => {
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        configSnapshot: '{}',
        intent: 'integrate',
        startedAt: 1,
      });
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main-2',
        featureBranchPreIntegrationSha: 'sha-feat-2',
        configSnapshot: '{"v":1}',
        intent: 'cancel',
        startedAt: 2,
      });

      expect(store.getIntegrationState()).toMatchObject({
        expectedParentSha: 'sha-main-2',
        intent: 'cancel',
        startedAt: 2,
      });
    });

    it('clears the marker', () => {
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        configSnapshot: '{}',
        intent: 'integrate',
        startedAt: 1,
      });
      store.clearIntegrationState();
      expect(store.getIntegrationState()).toBeUndefined();
    });

    it('round-trips the post-rebase SHA when set', () => {
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        featureBranchPostRebaseSha: 'sha-feat-rebased',
        configSnapshot: '{}',
        intent: 'integrate',
        startedAt: 1,
      });
      expect(store.getIntegrationState()).toEqual({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        featureBranchPostRebaseSha: 'sha-feat-rebased',
        configSnapshot: '{}',
        intent: 'integrate',
        startedAt: 1,
      });
    });

    it('clears post-rebase SHA on upsert when subsequent write omits it', () => {
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        featureBranchPostRebaseSha: 'sha-feat-rebased',
        configSnapshot: '{}',
        intent: 'integrate',
        startedAt: 1,
      });
      store.writeIntegrationState({
        featureId: 'f-1',
        expectedParentSha: 'sha-main',
        featureBranchPreIntegrationSha: 'sha-feat',
        configSnapshot: '{}',
        intent: 'integrate',
        startedAt: 1,
      });
      const reread = store.getIntegrationState();
      expect(reread?.featureBranchPostRebaseSha).toBeUndefined();
    });
  });
});
