import type {
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  Milestone,
  Task,
  TaskAgentRun,
  TokenUsageAggregate,
} from '@core/types/index';
import {
  agentRunToRow,
  eventToRow,
  featureToRow,
  milestoneToRow,
  rowToAgentRun,
  rowToEvent,
  rowToFeature,
  rowToMilestone,
  rowToTask,
  taskToRow,
} from '@persistence/codecs';
import type {
  AgentRunRow,
  EventRow,
  FeatureRow,
  MilestoneRow,
  TaskRow,
} from '@persistence/queries/index';
import { describe, expect, it } from 'vitest';

/**
 * Pure round-trip tests for the row↔entity codecs. These exercise the
 * nullable/optional field paths that higher-level PersistentFeatureGraph
 * behavior tests don't reach (e.g. tokenUsage, files_changed,
 * reserved_write_paths, suspended_files, event payload).
 */

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
    'claude-opus-4-6': {
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

function fullRow<R>(base: Omit<R, 'created_at' | 'updated_at'>): R {
  return { ...base, created_at: 10, updated_at: 20 } as R;
}

describe('codecs — round-trip', () => {
  describe('Milestone', () => {
    it('round-trips without steeringQueuePosition', () => {
      const m: Milestone = {
        id: 'm-1',
        name: 'M1',
        description: 'desc',
        status: 'pending',
        order: 0,
      };
      const row = fullRow<MilestoneRow>(milestoneToRow(m));
      expect(rowToMilestone(row)).toEqual(m);
    });

    it('round-trips with steeringQueuePosition set', () => {
      const m: Milestone = {
        id: 'm-1',
        name: 'M1',
        description: 'desc',
        status: 'pending',
        order: 0,
        steeringQueuePosition: 3,
      };
      const row = fullRow<MilestoneRow>(milestoneToRow(m));
      expect(row.steering_queue_position).toBe(3);
      expect(rowToMilestone(row)).toEqual(m);
    });
  });

  describe('Feature', () => {
    it('round-trips a minimal feature with no optional fields', () => {
      const f: Feature = {
        id: 'f-1',
        milestoneId: 'm-1',
        orderInMilestone: 0,
        name: 'F1',
        description: 'd',
        dependsOn: [],
        status: 'pending',
        workControl: 'discussing',
        collabControl: 'none',
        featureBranch: 'feat-f1',
        mergeTrainReentryCount: 0,
      };
      const row = fullRow<FeatureRow>(featureToRow(f));
      expect(rowToFeature(row, [])).toEqual(f);
    });

    it('round-trips a feature with tokenUsage, summary, merge-train state', () => {
      const f: Feature = {
        id: 'f-1',
        milestoneId: 'm-1',
        orderInMilestone: 2,
        name: 'F1',
        description: 'd',
        dependsOn: ['f-0'],
        status: 'in_progress',
        workControl: 'researching',
        collabControl: 'none',
        featureBranch: 'feat-f1',
        featureTestPolicy: 'strict',
        mergeTrainManualPosition: 5,
        mergeTrainEnteredAt: 1234,
        mergeTrainEntrySeq: 7,
        mergeTrainReentryCount: 2,
        runtimeBlockedByFeatureId: 'f-9',
        summary: 'summary text',
        tokenUsage: TOKEN_USAGE,
      };
      const row = fullRow<FeatureRow>(featureToRow(f));
      expect(row.token_usage).toContain('llmCalls');
      expect(row.runtime_blocked_by_feature_id).toBe('f-9');
      const decoded = rowToFeature(row, ['f-0']);
      expect(decoded).toEqual(f);
      expect(decoded.tokenUsage).toEqual(TOKEN_USAGE);
    });
  });

  describe('Task', () => {
    it('round-trips a minimal task with no optional fields', () => {
      const t: Task = {
        id: 't-1',
        featureId: 'f-1',
        orderInFeature: 0,
        description: 'T1',
        dependsOn: [],
        status: 'pending',
        collabControl: 'none',
        consecutiveFailures: 0,
      };
      const row = fullRow<TaskRow>(taskToRow(t));
      expect(rowToTask(row, [])).toEqual(t);
    });

    it('round-trips a task with tokenUsage, reservedWritePaths, and suspendedFiles', () => {
      const t: Task = {
        id: 't-1',
        featureId: 'f-1',
        orderInFeature: 1,
        description: 'T1',
        dependsOn: ['t-0'],
        status: 'stuck',
        collabControl: 'none',
        weight: 'medium',
        workerId: 'w-1',
        worktreeBranch: 'feat-f1-t1',
        reservedWritePaths: ['src/a.ts', 'src/b/c.ts'],
        blockedByFeatureId: 'f-2',
        tokenUsage: TOKEN_USAGE,
        taskTestPolicy: 'loose',
        sessionId: 'sess-1',
        consecutiveFailures: 2,
        suspendedAt: 9999,
        suspendReason: 'same_feature_overlap',
        suspendedFiles: ['src/x.ts'],
      };
      const row = fullRow<TaskRow>(taskToRow(t));
      expect(row.reserved_write_paths).toBe(
        JSON.stringify(['src/a.ts', 'src/b/c.ts']),
      );
      expect(row.suspended_files).toBe(JSON.stringify(['src/x.ts']));
      const decoded = rowToTask(row, ['t-0']);
      expect(decoded).toEqual(t);
    });

    it('round-trips a task with TaskResult including filesChanged', () => {
      const t: Task = {
        id: 't-1',
        featureId: 'f-1',
        orderInFeature: 0,
        description: 'T1',
        dependsOn: [],
        status: 'done',
        collabControl: 'none',
        consecutiveFailures: 0,
        result: {
          summary: 'did the thing',
          filesChanged: ['src/one.ts', 'src/two.ts'],
        },
      };
      const row = fullRow<TaskRow>(taskToRow(t));
      expect(row.result_summary).toBe('did the thing');
      expect(row.files_changed).toBe(
        JSON.stringify(['src/one.ts', 'src/two.ts']),
      );
      expect(rowToTask(row, [])).toEqual(t);
    });

    it('treats a row with null result_summary as no result', () => {
      const row: TaskRow = {
        id: 't-1',
        feature_id: 'f-1',
        order_in_feature: 0,
        description: 'T1',
        weight: null,
        status: 'pending',
        collab_status: 'none',
        worker_id: null,
        worktree_branch: null,
        reserved_write_paths: null,
        blocked_by_feature_id: null,
        result_summary: null,
        files_changed: null,
        token_usage: null,
        task_test_policy: null,
        session_id: null,
        consecutive_failures: 0,
        suspended_at: null,
        suspend_reason: null,
        suspended_files: null,
        created_at: 10,
        updated_at: 20,
      };
      const t = rowToTask(row, []);
      expect(t.result).toBeUndefined();
    });
  });

  describe('AgentRun', () => {
    it('round-trips a task-scoped run with all optional fields set', () => {
      const run: TaskAgentRun = {
        id: 'run-1',
        scopeType: 'task',
        scopeId: 't-1',
        phase: 'execute',
        runStatus: 'running',
        owner: 'system',
        attention: 'none',
        sessionId: 'sess-1',
        payloadJson: JSON.stringify({ hint: 'x' }),
        restartCount: 1,
        maxRetries: 3,
        retryAt: 5000,
      };
      const row = fullRow<AgentRunRow>(agentRunToRow(run));
      expect(rowToAgentRun(row)).toEqual(run);
    });

    it('round-trips a feature-phase run with minimal fields', () => {
      const run: FeaturePhaseAgentRun = {
        id: 'run-1',
        scopeType: 'feature_phase',
        scopeId: 'f-1',
        phase: 'discuss',
        runStatus: 'ready',
        owner: 'system',
        attention: 'none',
        restartCount: 0,
        maxRetries: 0,
      };
      const row = fullRow<AgentRunRow>(agentRunToRow(run));
      expect(rowToAgentRun(row)).toEqual(run);
    });

    it('round-trips an agent run with tokenUsage', () => {
      const run = {
        id: 'run-usage-1',
        scopeType: 'task',
        scopeId: 't-1',
        phase: 'execute',
        runStatus: 'completed',
        owner: 'system',
        attention: 'none',
        restartCount: 1,
        maxRetries: 3,
        tokenUsage: TOKEN_USAGE,
      } as TaskAgentRun;
      const row = fullRow<AgentRunRow>(agentRunToRow(run));
      expect(row.token_usage).toContain('llmCalls');
      expect(rowToAgentRun(row)).toMatchObject({
        ...run,
        tokenUsage: TOKEN_USAGE,
      });
    });
  });

  describe('Event', () => {
    it('round-trips an event with structured payload', () => {
      const e: EventRecord = {
        eventType: 'budget_warning',
        entityId: 'f-1',
        timestamp: 100,
        payload: { percent: 80, scope: 'global' },
      };
      const row: EventRow = { id: 1, ...eventToRow(e) };
      expect(rowToEvent(row)).toEqual(e);
    });

    it('round-trips an event with no payload', () => {
      const e: EventRecord = {
        eventType: 'task_failed',
        entityId: 't-1',
        timestamp: 200,
      };
      const row: EventRow = { id: 1, ...eventToRow(e) };
      expect(row.payload).toBeNull();
      const decoded = rowToEvent(row);
      expect(decoded).toEqual(e);
      expect(decoded.payload).toBeUndefined();
    });
  });
});
