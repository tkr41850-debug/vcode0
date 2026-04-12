import type {
  AgentRun,
  EventRecord,
  Feature,
  FeatureCollabControl,
  FeatureId,
  FeatureWorkControl,
  Milestone,
  MilestoneId,
  Task,
  TaskCollabControl,
  TaskId,
  TaskResult,
  TaskStatus,
  TaskSuspendReason,
  TaskWeight,
  TestPolicy,
  TokenUsageAggregate,
  UnitStatus,
} from '@core/types/index';
import type {
  AgentRunRow,
  EventRow,
  FeatureRow,
  MilestoneRow,
  TaskRow,
} from '@persistence/queries/index';

/**
 * Row ↔ entity converters for the sqlite persistence layer. Row shapes mirror
 * the on-disk schema exactly (snake_case, created_at/updated_at) while entity
 * shapes are the in-memory domain types used by the core graph.
 *
 * Conventions:
 * - Optional entity fields become `null` in rows and vice versa (driven by
 *   `exactOptionalPropertyTypes`).
 * - `created_at`/`updated_at` live only on rows — callers provide them via
 *   the `now()` clock at the write site.
 * - JSON-in-TEXT fields (`reserved_write_paths`, `files_changed`,
 *   `suspended_files`, `payload_json`, `token_usage`) are serialized through
 *   `JSON.stringify`/`JSON.parse` in the codec, so callers handle the
 *   higher-level TEXT payloads uniformly.
 */

function nullish<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function optional<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> {
  return value === null || value === undefined
    ? ({} as Partial<Record<K, V>>)
    : ({ [key]: value } as Partial<Record<K, V>>);
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

// ---------- Milestone ----------

export function milestoneToRow(
  m: Milestone,
): Omit<MilestoneRow, 'created_at' | 'updated_at'> {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    display_order: m.order,
    steering_queue_position: nullish(m.steeringQueuePosition),
    status: m.status,
  };
}

export function rowToMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    order: row.display_order,
    status: row.status,
    ...optional('steeringQueuePosition', row.steering_queue_position),
  };
}

// ---------- Feature ----------

export function featureToRow(
  f: Feature,
): Omit<FeatureRow, 'created_at' | 'updated_at'> {
  return {
    id: f.id,
    milestone_id: f.milestoneId,
    order_in_milestone: f.orderInMilestone,
    name: f.name,
    description: f.description,
    status: f.status,
    work_phase: f.workControl,
    collab_status: f.collabControl,
    feature_branch: f.featureBranch,
    feature_test_policy: nullish(f.featureTestPolicy),
    merge_train_manual_position: nullish(f.mergeTrainManualPosition),
    merge_train_entered_at: nullish(f.mergeTrainEnteredAt),
    merge_train_entry_seq: nullish(f.mergeTrainEntrySeq),
    merge_train_reentry_count: f.mergeTrainReentryCount ?? 0,
    summary: nullish(f.summary),
    token_usage: serializeJson(f.tokenUsage),
  };
}

export function rowToFeature(row: FeatureRow, dependsOn: FeatureId[]): Feature {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    orderInMilestone: row.order_in_milestone,
    name: row.name,
    description: row.description ?? '',
    dependsOn,
    status: row.status,
    workControl: row.work_phase,
    collabControl: row.collab_status,
    featureBranch: row.feature_branch,
    ...optional('featureTestPolicy', row.feature_test_policy),
    ...optional('mergeTrainManualPosition', row.merge_train_manual_position),
    ...optional('mergeTrainEnteredAt', row.merge_train_entered_at),
    ...optional('mergeTrainEntrySeq', row.merge_train_entry_seq),
    mergeTrainReentryCount: row.merge_train_reentry_count,
    ...optional('summary', row.summary),
    ...optional(
      'tokenUsage',
      parseJson<TokenUsageAggregate>(row.token_usage) ?? undefined,
    ),
  };
}

// ---------- Task ----------

export function taskToRow(t: Task): Omit<TaskRow, 'created_at' | 'updated_at'> {
  const filesChanged = t.result?.filesChanged;
  return {
    id: t.id,
    feature_id: t.featureId,
    order_in_feature: t.orderInFeature,
    description: t.description,
    weight: nullish(t.weight),
    status: t.status,
    collab_status: t.collabControl,
    worker_id: nullish(t.workerId),
    worktree_branch: nullish(t.worktreeBranch),
    reserved_write_paths: serializeJson(t.reservedWritePaths),
    blocked_by_feature_id: nullish(t.blockedByFeatureId),
    result_summary: nullish(t.result?.summary),
    files_changed: serializeJson(filesChanged),
    token_usage: serializeJson(t.tokenUsage),
    task_test_policy: nullish(t.taskTestPolicy),
    session_id: nullish(t.sessionId),
    consecutive_failures: t.consecutiveFailures ?? 0,
    suspended_at: nullish(t.suspendedAt),
    suspend_reason: nullish(t.suspendReason),
    suspended_files: serializeJson(t.suspendedFiles),
  };
}

export function rowToTask(row: TaskRow, dependsOn: TaskId[]): Task {
  const filesChanged = parseJson<string[]>(row.files_changed);
  const resultSummary = row.result_summary;
  const result: TaskResult | undefined =
    resultSummary !== null
      ? { summary: resultSummary, filesChanged: filesChanged ?? [] }
      : undefined;

  return {
    id: row.id,
    featureId: row.feature_id,
    orderInFeature: row.order_in_feature,
    description: row.description,
    dependsOn,
    status: row.status,
    collabControl: row.collab_status,
    ...optional('workerId', row.worker_id),
    ...optional('worktreeBranch', row.worktree_branch),
    ...optional('taskTestPolicy', row.task_test_policy),
    ...optional('result', result),
    ...optional('weight', row.weight),
    ...optional(
      'tokenUsage',
      parseJson<TokenUsageAggregate>(row.token_usage) ?? undefined,
    ),
    ...optional(
      'reservedWritePaths',
      parseJson<string[]>(row.reserved_write_paths) ?? undefined,
    ),
    ...optional('blockedByFeatureId', row.blocked_by_feature_id),
    ...optional('sessionId', row.session_id),
    consecutiveFailures: row.consecutive_failures,
    ...optional('suspendedAt', row.suspended_at),
    ...optional('suspendReason', row.suspend_reason),
    ...optional(
      'suspendedFiles',
      parseJson<string[]>(row.suspended_files) ?? undefined,
    ),
  };
}

// ---------- Agent Run ----------

export function agentRunToRow(
  r: AgentRun,
): Omit<AgentRunRow, 'created_at' | 'updated_at'> {
  const base = {
    id: r.id,
    phase: r.phase,
    run_status: r.runStatus,
    owner: r.owner,
    attention: r.attention,
    session_id: nullish(r.sessionId),
    payload_json: nullish(r.payloadJson),
    max_retries: r.maxRetries,
    restart_count: r.restartCount,
    retry_at: nullish(r.retryAt),
  };
  if (r.scopeType === 'task') {
    return { ...base, scope_type: 'task', scope_id: r.scopeId };
  }
  return { ...base, scope_type: 'feature_phase', scope_id: r.scopeId };
}

export function rowToAgentRun(row: AgentRunRow): AgentRun {
  const base = {
    id: row.id,
    phase: row.phase,
    runStatus: row.run_status,
    owner: row.owner,
    attention: row.attention,
    restartCount: row.restart_count,
    maxRetries: row.max_retries,
    ...optional('sessionId', row.session_id),
    ...optional('payloadJson', row.payload_json),
    ...optional('retryAt', row.retry_at),
  };
  if (row.scope_type === 'task') {
    return { ...base, scopeType: 'task', scopeId: row.scope_id as TaskId };
  }
  return {
    ...base,
    scopeType: 'feature_phase',
    scopeId: row.scope_id as FeatureId,
  };
}

// ---------- Event ----------

export function eventToRow(e: EventRecord): Omit<EventRow, 'id'> {
  return {
    timestamp: e.timestamp,
    event_type: e.eventType,
    entity_id: e.entityId,
    payload: serializeJson(e.payload),
  };
}

export function rowToEvent(row: EventRow): EventRecord {
  const parsed = parseJson<Record<string, unknown>>(row.payload);
  return {
    eventType: row.event_type,
    entityId: row.entity_id,
    timestamp: row.timestamp,
    ...optional('payload', parsed ?? undefined),
  };
}

// ---------- Re-exports (satisfy unused-import lint) ----------

// The following identifiers are part of the codec signatures even when not
// referenced in function bodies.
export type {
  FeatureCollabControl,
  FeatureWorkControl,
  MilestoneId,
  TaskCollabControl,
  TaskStatus,
  TaskSuspendReason,
  TaskWeight,
  TestPolicy,
  UnitStatus,
};
