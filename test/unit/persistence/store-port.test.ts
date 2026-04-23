import { isDeepStrictEqual } from 'node:util';

import type { AgentRun, EventRecord } from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { SqliteStore } from '@persistence/sqlite-store';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function usageAggregate() {
  return {
    llmCalls: 2,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    reasoningTokens: 10,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens: 158,
    usd: 0.0123,
    byModel: {
      'anthropic:claude-sonnet-4-6': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        llmCalls: 2,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 10,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        totalTokens: 158,
        usd: 0.0123,
      },
    },
  };
}

describe('SqliteStore port', () => {
  let db: Database.Database;
  let store: SqliteStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new SqliteStore(db, () => 1_000);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed by store.close() in individual tests */
    }
  });

  describe('agent_runs round-trip', () => {
    it('preserves every column including optional JSON fields', () => {
      const run: AgentRun = {
        id: 'run-1',
        scopeType: 'task',
        scopeId: 't-1',
        phase: 'execute',
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
        sessionId: 'sess-abc',
        payloadJson: JSON.stringify({ query: 'help please' }),
        tokenUsage: usageAggregate(),
        maxRetries: 3,
        restartCount: 1,
        retryAt: 5_000,
      };

      store.createAgentRun(run);
      const readBack = store.getAgentRun('run-1');

      expect(readBack).toBeDefined();
      expect(readBack).toEqual(run);
    });

    it('round-trips the feature_phase scope variant', () => {
      const run: AgentRun = {
        id: 'run-2',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'verify',
        runStatus: 'ready',
        owner: 'manual',
        attention: 'crashloop_backoff',
        maxRetries: 0,
        restartCount: 0,
      };

      store.createAgentRun(run);
      const readBack = store.getAgentRun('run-2');
      expect(readBack).toEqual(run);
    });

    it('listAgentRuns filters by scope type and run_status', () => {
      const baseline = {
        phase: 'execute' as const,
        owner: 'system' as const,
        attention: 'none' as const,
        maxRetries: 0,
        restartCount: 0,
      };

      store.createAgentRun({
        ...baseline,
        id: 'r-1',
        scopeType: 'task',
        scopeId: 't-1',
        runStatus: 'running',
      });
      store.createAgentRun({
        ...baseline,
        id: 'r-2',
        scopeType: 'task',
        scopeId: 't-2',
        runStatus: 'ready',
      });
      store.createAgentRun({
        ...baseline,
        id: 'r-3',
        phase: 'verify',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        runStatus: 'running',
      });

      const running = store.listAgentRuns({ runStatus: 'running' });
      expect(running.map((r) => r.id).sort()).toEqual(['r-1', 'r-3']);

      const taskRuns = store.listAgentRuns({ scopeType: 'task' });
      expect(taskRuns.map((r) => r.id).sort()).toEqual(['r-1', 'r-2']);
    });
  });

  describe('events append/query', () => {
    it('round-trips appended events with since/until filters', () => {
      const events: EventRecord[] = [
        {
          eventType: 'run.started',
          entityId: 't-1',
          timestamp: 100,
          payload: { foo: 'bar' },
        },
        {
          eventType: 'run.completed',
          entityId: 't-1',
          timestamp: 200,
          payload: { exit: 0 },
        },
        {
          eventType: 'warn.budget',
          entityId: 'f-1',
          timestamp: 300,
        },
      ];

      for (const event of events) {
        store.appendEvent(event);
      }

      expect(store.listEvents()).toEqual(events);
      expect(store.listEvents({ since: 150 })).toEqual([events[1], events[2]]);
      expect(store.listEvents({ until: 150 })).toEqual([events[0]]);
      expect(store.listEvents({ entityId: 'f-1' })).toEqual([events[2]]);
    });
  });

  describe('graph + snapshotGraph', () => {
    it('returns the same FeatureGraph instance across calls', () => {
      const g1 = store.graph();
      const g2 = store.graph();
      expect(g1).toBe(g2);
    });

    it('snapshotGraph() on an empty DB returns the canonical empty shape', () => {
      expect(store.snapshotGraph()).toEqual({
        milestones: [],
        features: [],
        tasks: [],
      });
    });

    it('graph mutations are reflected in snapshotGraph output', () => {
      const graph = store.graph();
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'feat',
      });

      const snap = store.snapshotGraph();
      expect(snap.milestones.map((m) => m.id)).toEqual(['m-1']);
      expect(snap.features.map((f) => f.id)).toEqual(['f-1']);
      expect(snap.tasks).toEqual([]);
    });
  });

  describe('rehydrate', () => {
    it('returns the empty canonical snapshot + no runs/events on a fresh DB', () => {
      const snap = store.rehydrate();
      expect(snap.graph).toEqual({
        milestones: [],
        features: [],
        tasks: [],
      });
      expect(snap.openRuns).toEqual([]);
      expect(snap.pendingEvents).toEqual([]);
    });

    it('returns only pre-terminal runs in openRuns', () => {
      const seed = (
        id: string,
        runStatus: AgentRun['runStatus'],
      ): AgentRun => ({
        id,
        scopeType: 'task',
        scopeId: `t-${id}`,
        phase: 'execute',
        runStatus,
        owner: 'system',
        attention: 'none',
        maxRetries: 0,
        restartCount: 0,
      });

      store.createAgentRun(seed('ready', 'ready'));
      store.createAgentRun(seed('running', 'running'));
      store.createAgentRun(seed('retry', 'retry_await'));
      store.createAgentRun(seed('await-resp', 'await_response'));
      store.createAgentRun(seed('await-appr', 'await_approval'));
      store.createAgentRun(seed('completed', 'completed'));
      store.createAgentRun(seed('failed', 'failed'));
      store.createAgentRun(seed('cancelled', 'cancelled'));

      const { openRuns } = store.rehydrate();
      const openIds = openRuns.map((r) => r.id).sort();
      expect(openIds).toEqual(
        ['ready', 'running', 'retry', 'await-resp', 'await-appr'].sort(),
      );
    });

    it('returns graph snapshot equal to snapshotGraph()', () => {
      const graph = store.graph();
      graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
      graph.createFeature({
        id: 'f-1',
        milestoneId: 'm-1',
        name: 'F',
        description: 'feat',
      });

      const direct = store.snapshotGraph();
      const viaRehydrate = store.rehydrate().graph;
      expect(isDeepStrictEqual(viaRehydrate, direct)).toBe(true);
    });
  });

  describe('close', () => {
    it('closes the underlying DB so subsequent reads throw', () => {
      store.close();
      expect(() => store.getAgentRun('missing')).toThrow();
    });
  });
});
