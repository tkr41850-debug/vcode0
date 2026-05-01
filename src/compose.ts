import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { type ApplicationLifecycle, GvcApplication } from '@app/index';
import { ALL_AGENT_ROLES, type GvcConfig, JsonConfigLoader } from '@config';
import type { FeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type {
  AgentRun,
  AppMode,
  EventRecord,
  FeatureId,
  MilestoneId,
  PlannerSessionMode,
  Task,
  TaskAgentRun,
  TaskId,
} from '@core/types/index';
import {
  getInboxEquivalenceKey,
  type InboxItemRecord,
  type InboxItemResolution,
  type OrchestratorPorts,
} from '@orchestrator/ports/index';
import { taskDispatchForRun } from '@orchestrator/scheduler/dispatch';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import {
  RecoveryService,
  VerificationService,
} from '@orchestrator/services/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { SqliteStore } from '@persistence/sqlite-store';
import { buildTaskPayload } from '@runtime/context/index';
import type {
  ApprovalDecision,
  ApprovalPayload,
  HelpResponse,
  RuntimePort,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { PiSdkHarness } from '@runtime/harness/index';
import {
  createFileToolOutputStore,
  type PersistedToolOutput,
} from '@runtime/resume';
import { buildRetryPolicyConfig } from '@runtime/retry-policy';
import { FileSessionStore } from '@runtime/sessions/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
import {
  createWorkerPidRegistry,
  GitWorktreeProvisioner,
  type WorktreeProvisioner,
} from '@runtime/worktree/index';
import { TuiApp } from '@tui/app';
import type { PlannerAuditEntry, PlannerAuditQuery } from '@tui/app-deps';

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

type StartupRecoverySummarySource = Awaited<
  ReturnType<RecoveryService['recoverStartupState']>
>;

interface RecoverySummaryInboxPayload {
  clearedLocks: number;
  preservedLocks: number;
  clearedDeadWorkerPids: number;
  resumedRuns: number;
  restartedRuns: number;
  attentionRuns: number;
  orphanTaskWorktrees: number;
}

type StartupRecoveryOrphanWorktreeSource =
  StartupRecoverySummarySource['orphanTaskWorktrees'][number];

interface OrphanWorktreeInboxPayload
  extends StartupRecoveryOrphanWorktreeSource {
  equivalenceKey: string;
}

interface LiveConfigDeps {
  runtime: Pick<
    LocalWorkerPool,
    'setMaxConcurrency' | 'setHotWindowMs' | 'setRetryPolicyConfig'
  >;
  scheduler: Pick<SchedulerLoop, 'setReentryCap'>;
  harness: Pick<PiSdkHarness, 'setTaskWorkerModel'>;
}

export async function applyConfigUpdate(
  configSource: JsonConfigLoader,
  currentConfig: GvcConfig,
  nextConfig: GvcConfig,
  deps: LiveConfigDeps,
  options: { persist?: boolean } = {},
): Promise<GvcConfig> {
  const normalized = normalizeConfig(nextConfig);
  if (options.persist !== false) {
    await configSource.save(normalized);
  }
  Object.assign(currentConfig, normalized);
  deps.runtime.setMaxConcurrency(normalized.workerCap);
  deps.runtime.setRetryPolicyConfig(buildRetryPolicyConfig(normalized));
  deps.runtime.setHotWindowMs(normalized.pauseTimeouts.hotWindowMs);
  deps.scheduler.setReentryCap(normalized.reentryCap);
  deps.harness.setTaskWorkerModel(normalized.models.taskWorker);
  return currentConfig;
}

function normalizeConfig(config: GvcConfig): GvcConfig {
  return {
    ...config,
    models: Object.fromEntries(
      ALL_AGENT_ROLES.map((role) => [role, { ...config.models[role] }]),
    ) as GvcConfig['models'],
    pauseTimeouts: { ...config.pauseTimeouts },
    retry: {
      ...config.retry,
      transientErrorPatterns: [...config.retry.transientErrorPatterns],
    },
    ...(config.budget !== undefined ? { budget: { ...config.budget } } : {}),
    ...(config.modelRouting !== undefined
      ? {
          modelRouting: {
            ...config.modelRouting,
            tiers: { ...config.modelRouting.tiers },
          },
        }
      : {}),
    ...(config.verification !== undefined
      ? {
          verification: {
            ...(config.verification.task !== undefined
              ? {
                  task: {
                    ...config.verification.task,
                    checks: [...config.verification.task.checks],
                  },
                }
              : {}),
            ...(config.verification.feature !== undefined
              ? {
                  feature: {
                    ...config.verification.feature,
                    checks: [...config.verification.feature.checks],
                  },
                }
              : {}),
            ...(config.verification.mergeTrain !== undefined
              ? {
                  mergeTrain: {
                    ...config.verification.mergeTrain,
                    checks: [...config.verification.mergeTrain.checks],
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(config.warnings !== undefined
      ? { warnings: { ...config.warnings } }
      : {}),
  };
}

function buildRecoverySummaryInboxPayload(
  report: StartupRecoverySummarySource,
): RecoverySummaryInboxPayload | undefined {
  const payload: RecoverySummaryInboxPayload = {
    clearedLocks: report.clearedLocks.length,
    preservedLocks: report.preservedLocks.length,
    clearedDeadWorkerPids: report.clearedDeadWorkerPids.length,
    resumedRuns: report.resumedRuns.length,
    restartedRuns: report.restartedRuns.length,
    attentionRuns: report.attentionRuns.length,
    orphanTaskWorktrees: report.orphanTaskWorktrees.length,
  };
  return Object.values(payload).some((value) => value > 0)
    ? payload
    : undefined;
}

function appendRecoverySummaryInboxItem(
  store: Pick<OrchestratorPorts['store'], 'appendInboxItem'>,
  report: StartupRecoverySummarySource,
): void {
  const payload = buildRecoverySummaryInboxPayload(report);
  if (payload === undefined) {
    return;
  }

  const ts = Date.now();
  store.appendInboxItem({
    id: `inbox-recovery-summary-${ts}`,
    ts,
    kind: 'recovery_summary',
    payload,
  });
}

function buildOrphanWorktreeEquivalenceKey(
  payload: Pick<OrphanWorktreeInboxPayload, 'branch' | 'path'>,
): string {
  return `orphan_worktree:${payload.branch}:${payload.path}`;
}

function buildOrphanWorktreeInboxPayload(
  orphan: StartupRecoveryOrphanWorktreeSource,
): OrphanWorktreeInboxPayload {
  return {
    ...orphan,
    equivalenceKey: buildOrphanWorktreeEquivalenceKey(orphan),
  };
}

function appendOrphanWorktreeInboxItems(
  store: Pick<OrchestratorPorts['store'], 'appendInboxItem' | 'listInboxItems'>,
  report: StartupRecoverySummarySource,
): void {
  const existingKeys = new Set(
    store
      .listInboxItems({ unresolvedOnly: true, kind: 'orphan_worktree' })
      .map((item) => getInboxEquivalenceKey(item)),
  );
  const ts = Date.now();

  for (const [index, orphan] of report.orphanTaskWorktrees.entries()) {
    const payload = buildOrphanWorktreeInboxPayload(orphan);
    if (existingKeys.has(payload.equivalenceKey)) {
      continue;
    }
    existingKeys.add(payload.equivalenceKey);
    store.appendInboxItem({
      id: `inbox-orphan-worktree-${ts}-${index}`,
      ts: ts + index,
      taskId: orphan.taskId,
      featureId: orphan.featureId,
      kind: 'orphan_worktree',
      payload,
    });
  }
}

type InboxResolutionStore = Pick<
  OrchestratorPorts['store'],
  'getAgentRun' | 'updateAgentRun' | 'listInboxItems' | 'resolveInboxItem'
>;

interface InboxResolutionDeps {
  store: InboxResolutionStore;
  runtime: Pick<
    RuntimePort,
    'dispatchTask' | 'respondToHelp' | 'decideApproval'
  >;
  graph?: Pick<FeatureGraph, 'tasks' | 'features'>;
  projectRoot?: string;
}

type LiveWaitStatus = 'await_response' | 'await_approval';

type CheckpointedWaitStatus =
  | 'checkpointed_await_response'
  | 'checkpointed_await_approval';

interface PersistedHelpWaitPayload {
  query: string;
  toolCallId: string;
}

type PersistedApprovalWaitPayload = ApprovalPayload & {
  toolCallId: string;
};

function getInboxItemById(
  store: Pick<OrchestratorPorts['store'], 'listInboxItems'>,
  inboxItemId: string,
): InboxItemRecord | undefined {
  return store.listInboxItems().find((item) => item.id === inboxItemId);
}

function findPendingTaskInboxItem(
  store: InboxResolutionStore,
  taskId: string,
  expected: 'help' | 'approval',
): InboxItemRecord | undefined {
  return store.listInboxItems({ unresolvedOnly: true, taskId }).find((item) => {
    if (expected === 'help') {
      return item.kind === 'agent_help';
    }
    return item.kind === 'agent_approval' || item.kind === 'destructive_action';
  });
}

function formatResolvedTaskTargets(taskIds: readonly string[]): string {
  return taskIds.join(', ');
}

function checkpointedStatusFor(
  runStatus: LiveWaitStatus,
): CheckpointedWaitStatus {
  return runStatus === 'await_response'
    ? 'checkpointed_await_response'
    : 'checkpointed_await_approval';
}

function classifyWaitRun(
  run: TaskAgentRun,
  expectedRunStatus: LiveWaitStatus,
): 'live' | 'checkpointed' | undefined {
  if (run.runStatus === expectedRunStatus) {
    return 'live';
  }
  if (run.runStatus === checkpointedStatusFor(expectedRunStatus)) {
    return 'checkpointed';
  }
  return undefined;
}

function parseRunPayloadJson(run: TaskAgentRun): unknown {
  if (run.payloadJson === undefined) {
    throw new Error(`task "${run.scopeId}" is missing persisted wait payload`);
  }
  try {
    return JSON.parse(run.payloadJson) as unknown;
  } catch {
    throw new Error(`task "${run.scopeId}" has invalid persisted wait payload`);
  }
}

function parseHelpWaitPayload(run: TaskAgentRun): PersistedHelpWaitPayload {
  const payload = parseRunPayloadJson(run);
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { query?: unknown }).query !== 'string' ||
    typeof (payload as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    throw new Error(`task "${run.scopeId}" has invalid persisted help payload`);
  }
  return {
    query: (payload as { query: string }).query,
    toolCallId: (payload as { toolCallId: string }).toolCallId,
  };
}

function parseApprovalWaitPayload(
  run: TaskAgentRun,
): PersistedApprovalWaitPayload {
  const payload = parseRunPayloadJson(run);
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    throw new Error(
      `task "${run.scopeId}" has invalid persisted approval payload`,
    );
  }
  const record = payload as ApprovalPayload & { toolCallId: string };
  if (
    record.kind !== 'custom' &&
    record.kind !== 'destructive_action' &&
    record.kind !== 'replan_proposal'
  ) {
    throw new Error(
      `task "${run.scopeId}" has invalid persisted approval payload`,
    );
  }
  return record;
}

function buildHelpToolOutput(
  toolCallId: string,
  query: string,
  response: HelpResponse,
) {
  const text =
    response.kind === 'answer'
      ? response.text
      : '[operator chose to discuss — expect follow-up steering]';
  return {
    toolCallId,
    toolName: 'request_help',
    content: [{ type: 'text' as const, text }],
    details: { query, responseKind: response.kind },
    isError: false,
    timestamp: Date.now(),
  };
}

function buildApprovalToolOutput(
  toolCallId: string,
  kind: ApprovalPayload['kind'],
  decision: ApprovalDecision,
) {
  const text =
    decision.kind === 'approved'
      ? 'approved'
      : decision.kind === 'approve_always'
        ? 'approved (always)'
        : decision.kind === 'reject'
          ? `rejected${decision.comment !== undefined ? `: ${decision.comment}` : ''}`
          : 'operator chose to discuss';
  return {
    toolCallId,
    toolName: 'request_approval',
    content: [{ type: 'text' as const, text }],
    details: { kind, decision: decision.kind },
    isError: false,
    timestamp: Date.now(),
  };
}

async function resumeCheckpointedWait(
  deps: InboxResolutionDeps,
  run: TaskAgentRun,
  output: PersistedToolOutput,
): Promise<void> {
  if (deps.graph === undefined || deps.projectRoot === undefined) {
    throw new Error('checkpointed wait replay requires graph and projectRoot');
  }
  if (run.sessionId === undefined) {
    throw new Error(`task "${run.scopeId}" checkpointed wait has no sessionId`);
  }

  await createFileToolOutputStore(
    path.join(deps.projectRoot, '.gvc0', 'tool-outputs', run.sessionId),
  ).record(output);

  const task = deps.graph.tasks.get(run.scopeId);
  if (task === undefined) {
    throw new Error(`task "${run.scopeId}" not found`);
  }
  const feature = deps.graph.features.get(task.featureId);
  const result = await deps.runtime.dispatchTask(
    task,
    taskDispatchForRun(run),
    buildTaskPayload(task, feature),
  );
  if (result.kind === 'not_resumable') {
    throw new Error(
      `task "${run.scopeId}" checkpointed wait is not resumable: ${result.reason}`,
    );
  }

  deps.store.updateAgentRun(run.id, {
    runStatus: 'running',
    owner: 'manual',
    sessionId: result.sessionId,
    restartCount: run.restartCount + 1,
  });
}

async function resolveEquivalentInboxItems(params: {
  deps: InboxResolutionDeps;
  inboxItemId: string;
  expectedRunStatus: LiveWaitStatus;
  resolutionKind: InboxItemResolution['kind'];
  note?: string;
  deliver: (run: TaskAgentRun, taskId: string) => Promise<boolean>;
}): Promise<string[]> {
  const {
    deps,
    inboxItemId,
    expectedRunStatus,
    resolutionKind,
    note,
    deliver,
  } = params;
  const selected = getInboxItemById(deps.store, inboxItemId);
  if (selected === undefined) {
    throw new Error(`inbox item "${inboxItemId}" not found`);
  }
  if (selected.resolution !== undefined) {
    throw new Error(`inbox item "${inboxItemId}" is already resolved`);
  }

  const equivalenceKey = getInboxEquivalenceKey(selected);
  const candidates = deps.store
    .listInboxItems({ unresolvedOnly: true })
    .filter((item) => getInboxEquivalenceKey(item) === equivalenceKey);
  const deliveredTaskIds = new Set<string>();

  for (const item of candidates) {
    if (item.taskId === undefined || deliveredTaskIds.has(item.taskId)) {
      continue;
    }

    const run = deps.store.getAgentRun(`run-task:${item.taskId}`);
    if (run?.scopeType !== 'task') {
      continue;
    }
    if (classifyWaitRun(run, expectedRunStatus) === undefined) {
      continue;
    }

    const delivered = await deliver(run, item.taskId);
    if (!delivered) {
      continue;
    }

    deliveredTaskIds.add(item.taskId);
  }

  const fanoutTaskIds = [...deliveredTaskIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (fanoutTaskIds.length === 0) {
    throw new Error(`inbox item "${inboxItemId}" has no matching waits`);
  }

  const resolution: InboxItemResolution = {
    kind: resolutionKind,
    resolvedAt: Date.now(),
    ...(note !== undefined ? { note } : {}),
    fanoutTaskIds,
  };

  for (const item of candidates) {
    if (item.taskId !== undefined && deliveredTaskIds.has(item.taskId)) {
      deps.store.resolveInboxItem(item.id, resolution);
    }
  }

  return fanoutTaskIds;
}

export async function respondToInboxHelp(
  deps: InboxResolutionDeps,
  inboxItemId: string,
  response: HelpResponse,
): Promise<string> {
  const fanoutTaskIds = await resolveEquivalentInboxItems({
    deps,
    inboxItemId,
    expectedRunStatus: 'await_response',
    resolutionKind: response.kind === 'answer' ? 'answered' : 'dismissed',
    ...(response.kind === 'answer' ? { note: response.text } : {}),
    deliver: async (run, taskId) => {
      const kind = classifyWaitRun(run, 'await_response');
      if (kind === 'live') {
        const result = await deps.runtime.respondToHelp(taskId, response);
        if (result.kind !== 'delivered') {
          return false;
        }
        deps.store.updateAgentRun(run.id, {
          runStatus: 'running',
          owner: 'manual',
        });
        return true;
      }
      if (kind === 'checkpointed') {
        const payload = parseHelpWaitPayload(run);
        await resumeCheckpointedWait(
          deps,
          run,
          buildHelpToolOutput(payload.toolCallId, payload.query, response),
        );
        return true;
      }
      return false;
    },
  });
  return `Sent help response to ${formatResolvedTaskTargets(fanoutTaskIds)}.`;
}

export async function decideInboxApproval(
  deps: InboxResolutionDeps,
  inboxItemId: string,
  decision: ApprovalDecision,
): Promise<string> {
  const fanoutTaskIds = await resolveEquivalentInboxItems({
    deps,
    inboxItemId,
    expectedRunStatus: 'await_approval',
    resolutionKind:
      decision.kind === 'reject'
        ? 'rejected'
        : decision.kind === 'discuss'
          ? 'dismissed'
          : 'approved',
    ...(decision.kind === 'reject' && decision.comment !== undefined
      ? { note: decision.comment }
      : {}),
    deliver: async (run, taskId) => {
      const kind = classifyWaitRun(run, 'await_approval');
      if (kind === 'live') {
        const result = await deps.runtime.decideApproval(taskId, decision);
        if (result.kind !== 'delivered') {
          return false;
        }
        deps.store.updateAgentRun(run.id, {
          runStatus: 'running',
          owner: 'manual',
        });
        return true;
      }
      if (kind === 'checkpointed') {
        const payload = parseApprovalWaitPayload(run);
        await resumeCheckpointedWait(
          deps,
          run,
          buildApprovalToolOutput(payload.toolCallId, payload.kind, decision),
        );
        return true;
      }
      return false;
    },
  });
  return decision.kind === 'reject'
    ? `Rejected ${formatResolvedTaskTargets(fanoutTaskIds)}.`
    : decision.kind === 'discuss'
      ? `Dismissed ${formatResolvedTaskTargets(fanoutTaskIds)}.`
      : `Approved ${formatResolvedTaskTargets(fanoutTaskIds)}.`;
}

function parseOrphanWorktreeInboxPayload(
  payload: unknown,
): OrphanWorktreeInboxPayload | undefined {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.taskId !== 'string' ||
    typeof record.featureId !== 'string' ||
    typeof record.branch !== 'string' ||
    typeof record.path !== 'string' ||
    (record.ownerState !== 'dead' && record.ownerState !== 'absent') ||
    typeof record.registered !== 'boolean' ||
    typeof record.hasMetadataIndexLock !== 'boolean' ||
    typeof record.equivalenceKey !== 'string'
  ) {
    return undefined;
  }
  return record as unknown as OrphanWorktreeInboxPayload;
}

function getOrphanWorktreeInboxRecord(
  store: Pick<OrchestratorPorts['store'], 'listInboxItems'>,
  inboxItemId: string,
): { item: InboxItemRecord; payload: OrphanWorktreeInboxPayload } {
  const item = getInboxItemById(store, inboxItemId);
  if (item === undefined) {
    throw new Error(`inbox item "${inboxItemId}" not found`);
  }
  if (item.resolution !== undefined) {
    throw new Error(`inbox item "${inboxItemId}" is already resolved`);
  }
  if (item.kind !== 'orphan_worktree') {
    throw new Error(
      `inbox item "${inboxItemId}" is not an orphan worktree item`,
    );
  }
  const payload = parseOrphanWorktreeInboxPayload(item.payload);
  if (payload === undefined) {
    throw new Error(`inbox item "${inboxItemId}" has invalid orphan payload`);
  }
  return { item, payload };
}

function assertManagedOrphanWorktreePath(
  projectRoot: string,
  payload: OrphanWorktreeInboxPayload,
): void {
  const expectedPath = path.join(projectRoot, worktreePath(payload.branch));
  if (path.normalize(payload.path) !== path.normalize(expectedPath)) {
    throw new Error(
      `inbox item for ${payload.branch} does not point to a managed task worktree`,
    );
  }
}

function resolveOrphanWorktreeInboxItem(
  store: Pick<OrchestratorPorts['store'], 'resolveInboxItem'>,
  item: InboxItemRecord,
  note: string,
): void {
  store.resolveInboxItem(item.id, {
    kind: 'dismissed',
    resolvedAt: Date.now(),
    note,
    ...(item.taskId !== undefined ? { fanoutTaskIds: [item.taskId] } : {}),
  });
}

export async function cleanOrphanWorktree(
  deps: {
    store: Pick<
      OrchestratorPorts['store'],
      'listInboxItems' | 'resolveInboxItem'
    >;
    worktree: Pick<WorktreeProvisioner, 'removeWorktree'>;
    projectRoot: string;
  },
  inboxItemId: string,
): Promise<string> {
  const { item, payload } = getOrphanWorktreeInboxRecord(
    deps.store,
    inboxItemId,
  );
  assertManagedOrphanWorktreePath(deps.projectRoot, payload);
  await deps.worktree.removeWorktree(payload.branch);
  resolveOrphanWorktreeInboxItem(deps.store, item, `cleaned ${payload.branch}`);
  return `Removed orphan worktree ${payload.branch}.`;
}

export async function inspectOrphanWorktree(
  deps: {
    store: Pick<OrchestratorPorts['store'], 'listInboxItems'>;
    projectRoot: string;
  },
  inboxItemId: string,
): Promise<string> {
  const { payload } = getOrphanWorktreeInboxRecord(deps.store, inboxItemId);
  assertManagedOrphanWorktreePath(deps.projectRoot, payload);
  const relativePath =
    path.relative(deps.projectRoot, payload.path) || payload.path;
  return `Orphan ${payload.branch} owner=${payload.ownerState} registered=${payload.registered ? 'yes' : 'no'} lock=${payload.hasMetadataIndexLock ? 'yes' : 'no'} path=${relativePath}`;
}

export async function keepOrphanWorktree(
  deps: {
    store: Pick<
      OrchestratorPorts['store'],
      'listInboxItems' | 'resolveInboxItem'
    >;
    projectRoot: string;
  },
  inboxItemId: string,
): Promise<string> {
  const { item, payload } = getOrphanWorktreeInboxRecord(
    deps.store,
    inboxItemId,
  );
  assertManagedOrphanWorktreePath(deps.projectRoot, payload);
  resolveOrphanWorktreeInboxItem(deps.store, item, `kept ${payload.branch}`);
  return `Kept orphan worktree ${payload.branch}.`;
}

const TOP_PLANNER_ENTITY_ID = 'top-planner';

function normalizePlannerAuditIds<T extends string>(
  value: unknown,
  prefix: string,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is T =>
        typeof entry === 'string' && entry.startsWith(prefix),
    )
    .sort((left, right) => left.localeCompare(right));
}

function readPlannerSessionMode(
  value: unknown,
): PlannerSessionMode | undefined {
  return value === 'continue' || value === 'fresh' ? value : undefined;
}

function plannerAuditCollisionCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function readPlannerAuditMetadata(
  value: unknown,
): Omit<PlannerAuditEntry, 'ts' | 'action' | 'detail'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      featureIds: [],
      milestoneIds: [],
      collisionCount: 0,
    };
  }

  const record = value as Record<string, unknown>;
  const sessionMode = readPlannerSessionMode(record.sessionMode);
  return {
    ...(typeof record.prompt === 'string' ? { prompt: record.prompt } : {}),
    ...(sessionMode !== undefined ? { sessionMode } : {}),
    ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
    ...(typeof record.sessionId === 'string'
      ? { sessionId: record.sessionId }
      : {}),
    ...(typeof record.previousSessionId === 'string'
      ? { previousSessionId: record.previousSessionId }
      : {}),
    featureIds: normalizePlannerAuditIds<FeatureId>(record.featureIds, 'f-'),
    milestoneIds: normalizePlannerAuditIds<MilestoneId>(
      record.milestoneIds,
      'm-',
    ),
    collisionCount: plannerAuditCollisionCount(record.collidedFeatureRuns),
  };
}

function plannerAuditDetail(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (typeof payload.summary === 'string') {
    return payload.summary;
  }
  if (typeof payload.comment === 'string') {
    return payload.comment;
  }
  if (typeof payload.error === 'string') {
    return payload.error;
  }
  return undefined;
}

function readPlannerAuditEntry(
  event: EventRecord,
): PlannerAuditEntry | undefined {
  if (event.entityId !== TOP_PLANNER_ENTITY_ID) {
    return undefined;
  }

  const payload = event.payload;
  switch (event.eventType) {
    case 'top_planner_requested': {
      const sessionMode = readPlannerSessionMode(payload?.sessionMode);
      return {
        ts: event.timestamp,
        action: 'requested',
        ...(typeof payload?.prompt === 'string'
          ? { prompt: payload.prompt }
          : {}),
        ...(sessionMode !== undefined ? { sessionMode } : {}),
        featureIds: [],
        milestoneIds: [],
        collisionCount: 0,
      };
    }
    case 'top_planner_prompt_recorded':
      return {
        ts: event.timestamp,
        action: 'prompt_recorded',
        ...readPlannerAuditMetadata(payload),
      };
    case 'proposal_rerun_requested': {
      const sessionMode = readPlannerSessionMode(payload?.sessionMode);
      const detail = plannerAuditDetail(payload);
      return {
        ts: event.timestamp,
        action: 'rerun_requested',
        ...(sessionMode !== undefined ? { sessionMode } : {}),
        ...(detail !== undefined ? { detail } : {}),
        featureIds: [],
        milestoneIds: [],
        collisionCount: 0,
      };
    }
    case 'proposal_applied':
    case 'proposal_rejected':
    case 'proposal_apply_failed': {
      const detail = plannerAuditDetail(payload);
      return {
        ts: event.timestamp,
        action:
          event.eventType === 'proposal_applied'
            ? 'applied'
            : event.eventType === 'proposal_rejected'
              ? 'rejected'
              : 'apply_failed',
        ...(detail !== undefined ? { detail } : {}),
        ...readPlannerAuditMetadata(payload?.extra),
      };
    }
    case 'proposal_collision_resolved': {
      const collisionCount = plannerAuditCollisionCount(
        payload?.collidedFeatureRuns,
      );
      return {
        ts: event.timestamp,
        action: 'collision_resolved',
        featureIds: normalizePlannerAuditIds<FeatureId>(
          payload?.featureIds,
          'f-',
        ),
        milestoneIds: [],
        collisionCount,
        ...(collisionCount > 0
          ? {
              detail:
                collisionCount === 1
                  ? 'resolved 1 collided planner run'
                  : `resolved ${collisionCount} collided planner runs`,
            }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

export function listPlannerAuditEntries(
  store: Pick<OrchestratorPorts['store'], 'listEvents'>,
  query?: PlannerAuditQuery,
): PlannerAuditEntry[] {
  return store
    .listEvents({ entityId: TOP_PLANNER_ENTITY_ID })
    .map((event) => readPlannerAuditEntry(event))
    .filter((entry): entry is PlannerAuditEntry => entry !== undefined)
    .filter((entry) =>
      query?.featureId === undefined
        ? true
        : entry.featureIds.includes(query.featureId),
    )
    .sort((left, right) => {
      if (left.ts !== right.ts) {
        return right.ts - left.ts;
      }
      return left.action.localeCompare(right.action);
    });
}

export async function composeApplication(): Promise<GvcApplication> {
  const projectRoot = process.cwd();
  await ensureRuntimeDirs(projectRoot);

  const configSource = new JsonConfigLoader();
  const config = await configSource.load();
  const db = openDatabase(path.join(projectRoot, '.gvc0', 'state.db'));
  const graph = new PersistentFeatureGraph(db);
  const store = new SqliteStore(db);
  const sessionStore = new FileSessionStore(projectRoot);
  const runtimeWorkerCap = Math.max(1, Math.floor(config.workerCap));

  const schedulerRef: { current: SchedulerLoop | undefined } = {
    current: undefined,
  };
  const stopApplicationRef: { current: (() => Promise<void>) | undefined } = {
    current: undefined,
  };

  let runtime: LocalWorkerPool;

  const ui = new TuiApp({
    snapshot: () => graph.snapshot(),
    listAgentRuns: () => store.listAgentRuns(),
    listInboxItems: (query) =>
      store.listInboxItems({
        ...(query ?? {}),
        unresolvedOnly: true,
      }),
    listPlannerAuditEntries: (query) => listPlannerAuditEntries(store, query),
    getConfig: () => config,
    updateConfig: (nextConfig) =>
      applyConfigUpdate(configSource, config, nextConfig, {
        runtime,
        scheduler,
        harness,
      }),
    getWorkerCounts: () => {
      const idleWorkers = runtime.idleWorkerCount();
      const totalWorkers = runtime.maxWorkerCount();
      return {
        runningWorkers: Math.max(0, totalWorkers - idleWorkers),
        idleWorkers,
        totalWorkers,
      };
    },
    isAutoExecutionEnabled: () =>
      schedulerRef.current?.isAutoExecutionEnabled() ?? false,
    setAutoExecutionEnabled: (enabled) => {
      return schedulerRef.current?.setAutoExecutionEnabled(enabled) ?? enabled;
    },
    toggleAutoExecution: () => {
      const next = !(schedulerRef.current?.isAutoExecutionEnabled() ?? false);
      return schedulerRef.current?.setAutoExecutionEnabled(next) ?? next;
    },
    toggleMilestoneQueue: (milestoneId) => {
      // Plan 04-01 Task 3: route through the scheduler event queue so the
      // mutation runs inside a tick (guarded by __enterTick/__leaveTick).
      schedulerRef.current?.enqueue({
        type: 'ui_toggle_milestone_queue',
        milestoneId,
      });
    },
    setMergeTrainManualPosition: (featureId, position) => {
      schedulerRef.current?.enqueue({
        type: 'ui_set_merge_train_position',
        featureId,
        position,
      });
    },
    initializeProject: (input) => {
      return initializeProjectGraph(graph, input);
    },
    cancelFeature: (featureId) => {
      // Plan 04-01 Task 3: the handler invokes cancelFeatureRunWork via
      // the closure threaded into SchedulerLoopOptions below, keeping all
      // graph mutations inside the tick boundary.
      schedulerRef.current?.enqueue({
        type: 'ui_cancel_feature_run_work',
        featureId,
      });
      return Promise.resolve();
    },
    cancelTaskPreserveWorktree: (taskId) => {
      schedulerRef.current?.enqueue({
        type: 'ui_cancel_task_preserve_worktree',
        taskId,
      });
      return Promise.resolve();
    },
    cancelTaskCleanWorktree: (taskId) => {
      schedulerRef.current?.enqueue({
        type: 'ui_cancel_task_clean_worktree',
        taskId,
      });
      return Promise.resolve();
    },
    abandonFeatureBranch: (featureId) => {
      schedulerRef.current?.enqueue({
        type: 'ui_abandon_feature_branch',
        featureId,
      });
      return Promise.resolve();
    },
    saveFeatureRun: (run) => {
      const existing = store.getAgentRun(run.id);
      if (existing === undefined) {
        store.createAgentRun(run);
        return;
      }
      store.updateAgentRun(run.id, {
        phase: run.phase,
        runStatus: run.runStatus,
        owner: run.owner,
        attention: run.attention,
        restartCount: run.restartCount,
        maxRetries: run.maxRetries,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(run.payloadJson !== undefined
          ? { payloadJson: run.payloadJson }
          : {}),
        ...(run.retryAt !== undefined ? { retryAt: run.retryAt } : {}),
      });
    },
    getFeatureRun: (featureId, phase) => {
      const run = store.getAgentRun(`run-feature:${featureId}:${phase}`);
      return run?.scopeType === 'feature_phase' ? run : undefined;
    },
    getTopPlannerRun: () => {
      const run = store.getAgentRun('run-top-planner');
      return run?.scopeType === 'top_planner' ? run : undefined;
    },
    requestTopLevelPlan: (
      prompt,
      options?: { sessionMode?: PlannerSessionMode },
    ) => {
      const run = store.getAgentRun('run-top-planner');
      if (
        run !== undefined &&
        (run.runStatus === 'ready' ||
          run.runStatus === 'running' ||
          run.runStatus === 'retry_await' ||
          run.runStatus === 'await_approval' ||
          run.runStatus === 'await_response')
      ) {
        return 'Top-level planner already active.';
      }
      schedulerRef.current?.enqueue({
        type: 'top_planner_requested',
        prompt,
        sessionMode: options?.sessionMode ?? 'fresh',
      });
      return 'Queued top-level planning request.';
    },
    getTaskRun: (taskId) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      return run?.scopeType === 'task' ? run : undefined;
    },
    enqueueApprovalDecision: (event) => {
      schedulerRef.current?.enqueue({
        type: 'feature_phase_approval_decision',
        featureId: event.featureId,
        phase: event.phase,
        decision: event.decision,
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
      });
    },
    enqueueTopPlannerApprovalDecision: (event) => {
      schedulerRef.current?.enqueue({
        type: 'top_planner_approval_decision',
        decision: event.decision,
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
      });
    },
    rerunFeatureProposal: (event) => {
      schedulerRef.current?.enqueue({
        type: 'feature_phase_rerun_requested',
        featureId: event.featureId,
        phase: event.phase,
      });
    },
    rerunTopPlannerProposal: (event) => {
      schedulerRef.current?.enqueue({
        type: 'top_planner_rerun_requested',
        sessionMode: event?.sessionMode ?? 'fresh',
        ...(event?.reason !== undefined ? { reason: event.reason } : {}),
      });
    },
    respondToInboxHelp: (inboxItemId, response) =>
      respondToInboxHelp(
        { store, runtime, graph, projectRoot },
        inboxItemId,
        response,
      ),
    decideInboxApproval: (inboxItemId, decision) =>
      decideInboxApproval(
        { store, runtime, graph, projectRoot },
        inboxItemId,
        decision,
      ),
    cleanOrphanWorktree: (inboxItemId) =>
      cleanOrphanWorktree({ store, worktree, projectRoot }, inboxItemId),
    inspectOrphanWorktree: (inboxItemId) =>
      inspectOrphanWorktree({ store, projectRoot }, inboxItemId),
    keepOrphanWorktree: (inboxItemId) =>
      keepOrphanWorktree({ store, projectRoot }, inboxItemId),
    respondToTaskHelp: async (taskId, response) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (
        run.runStatus !== 'await_response' &&
        run.runStatus !== 'checkpointed_await_response'
      ) {
        throw new Error(`task "${taskId}" is not waiting for help`);
      }

      const inboxItem = findPendingTaskInboxItem(store, taskId, 'help');
      if (inboxItem === undefined) {
        throw new Error(`task "${taskId}" has no pending inbox help item`);
      }

      return respondToInboxHelp(
        { store, runtime, graph, projectRoot },
        inboxItem.id,
        response,
      );
    },
    decideTaskApproval: async (taskId, decision) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (
        run.runStatus !== 'await_approval' &&
        run.runStatus !== 'checkpointed_await_approval'
      ) {
        throw new Error(`task "${taskId}" is not waiting for approval`);
      }

      const inboxItem = findPendingTaskInboxItem(store, taskId, 'approval');
      if (inboxItem === undefined) {
        throw new Error(`task "${taskId}" has no pending inbox approval item`);
      }

      return decideInboxApproval(
        { store, runtime, graph, projectRoot },
        inboxItem.id,
        decision,
      );
    },
    sendTaskManualInput: async (taskId, text) => {
      const run = store.getAgentRun(`run-task:${taskId}`);
      if (run?.scopeType !== 'task') {
        throw new Error(`task "${taskId}" has no run`);
      }
      if (run.runStatus !== 'running' || run.owner !== 'manual') {
        throw new Error(`task "${taskId}" is not open for manual input`);
      }

      const result = await runtime.sendManualInput(taskId, text);
      if (result.kind !== 'delivered') {
        throw new Error(`task "${taskId}" is not running`);
      }

      store.updateAgentRun(run.id, {
        runStatus: 'running',
        owner: 'manual',
      });
      return `Sent input to ${taskId}.`;
    },
    quit: async () => {
      await stopApplicationRef.current?.();
    },
  });

  const pidRegistry = createWorkerPidRegistry(store);
  const harness = new PiSdkHarness(
    sessionStore,
    projectRoot,
    undefined,
    {},
    pidRegistry,
    // Plan 03-03: thread config.models.taskWorker into the forked worker
    // via env. Closes the REQ-CONFIG-01 hard-code gap at worker/entry.ts.
    config.models.taskWorker,
  );
  runtime = new LocalWorkerPool(
    harness,
    runtimeWorkerCap,
    (message) => {
      // Health heartbeat frames are handled by the harness layer — drop
      // them here so consumers can assume task-scoped fields are present.
      if (message.type === 'health_pong') return;
      const workerOutput = formatWorkerOutput(message);
      if (workerOutput !== undefined) {
        ui.onWorkerOutput(message.agentRunId, message.taskId, workerOutput);
      }
      schedulerRef.current?.enqueue({ type: 'worker_message', message });
    },
    // === Retry policy + inbox escalation (plan 03-03) ===
    // REQ-EXEC-04: transient failures backoff in-pool; semantic failures
    // escalate to `inbox_items` (migration 0005). Compile the config's
    // string patterns to RegExp once at pool construction.
    {
      store,
      config: buildRetryPolicyConfig(config),
    },
    {
      hotWindowMs: config.pauseTimeouts.hotWindowMs,
    },
  );
  const agents = new PiFeatureAgentRuntime({
    modelId: config.modelRouting?.ceiling ?? DEFAULT_MODEL_ID,
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot,
    getApiKey,
    // Plan 04-01 Task 3: route agent-runtime graph edits through the
    // scheduler event queue so they run inside a tick.
    enqueueGraphMutation: (featureId, mutation) => {
      schedulerRef.current?.enqueue({
        type: 'feature_phase_graph_mutation',
        featureId,
        mutation,
      });
    },
  });

  const verification = new VerificationService({ config }, projectRoot);
  const worktree = new GitWorktreeProvisioner(projectRoot);
  const ports: OrchestratorPorts = {
    store,
    runtime,
    sessionStore,
    agents,
    verification,
    worktree,
    ui,
    config,
  };

  const scheduler = new SchedulerLoop(graph, ports, {
    // Plan 04-01 Task 3: thread cancel closures so queue-routed UI actions
    // execute inside a scheduler tick instead of mutating the graph directly.
    cancelFeatureRunWork: (featureId) =>
      cancelFeatureRunWork({ graph, store, runtime }, featureId),
    cancelTaskPreserveWorktree: (taskId) =>
      cancelTaskPreserveWorktree({ graph, store, runtime }, taskId),
    cancelTaskCleanWorktree: (taskId) =>
      cancelTaskCleanWorktree({ graph, store, runtime, worktree }, taskId),
    abandonFeatureBranch: (featureId) =>
      abandonFeatureBranch({ graph, store, runtime, worktree }, featureId),
  });
  const recovery = new RecoveryService(ports, graph, pidRegistry, projectRoot);
  schedulerRef.current = scheduler;
  await applyConfigUpdate(
    configSource,
    config,
    config,
    {
      runtime,
      scheduler,
      harness,
    },
    { persist: false },
  );

  const app = new GvcApplication(ports, {
    prepare: (mode: AppMode) => {
      scheduler.setAutoExecutionEnabled(mode === 'auto');
    },
    start: async () => {
      const report = await recovery.recoverStartupState();
      appendRecoverySummaryInboxItem(store, report);
      appendOrphanWorktreeInboxItems(store, report);
      await scheduler.run();
      ui.refresh();
    },
    stop: async () => {
      try {
        await scheduler.stop();
      } finally {
        db.close();
      }
    },
  } satisfies ApplicationLifecycle);
  stopApplicationRef.current = () => app.stop();
  return app;
}

async function ensureRuntimeDirs(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, '.gvc0'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, '.gvc0', 'worktrees'), {
    recursive: true,
  });
}

export function initializeProjectGraph(
  graph: PersistentFeatureGraph,
  input: {
    milestoneName: string;
    milestoneDescription: string;
    featureName: string;
    featureDescription: string;
  },
): { milestoneId: MilestoneId; featureId: FeatureId } {
  const snapshot = graph.snapshot();
  if (snapshot.milestones.length > 0 || snapshot.features.length > 0) {
    throw new Error('project already initialized');
  }

  const milestoneId: MilestoneId = 'm-1';
  graph.createMilestone({
    id: milestoneId,
    name: input.milestoneName,
    description: input.milestoneDescription,
  });
  graph.queueMilestone(milestoneId);

  const featureId: FeatureId = 'f-1';
  graph.createFeature({
    id: featureId,
    milestoneId,
    name: input.featureName,
    description: input.featureDescription,
  });
  transitionFeatureToPlanning(graph, featureId);

  return { milestoneId, featureId };
}

function transitionFeatureToPlanning(
  graph: PersistentFeatureGraph,
  featureId: FeatureId,
): void {
  graph.transitionFeature(featureId, { status: 'in_progress' });
  graph.transitionFeature(featureId, { status: 'done' });
  graph.transitionFeature(featureId, {
    workControl: 'researching',
    status: 'pending',
  });
  graph.transitionFeature(featureId, { status: 'in_progress' });
  graph.transitionFeature(featureId, { status: 'done' });
  graph.transitionFeature(featureId, {
    workControl: 'planning',
    status: 'pending',
  });
}

export function formatWorkerOutput(
  message: WorkerToOrchestratorMessage,
): string | undefined {
  switch (message.type) {
    case 'progress':
      return message.message;
    case 'assistant_output':
      return message.text;
    case 'request_help':
      return `help requested: ${message.query}`;
    case 'request_approval':
      return `approval requested: ${summarizeApprovalPayload(message.payload)}`;
    case 'error':
      return `error: ${message.error}`;
    case 'result':
      return `completed: ${message.result.summary}`;
  }
}

type AgentRunCancellationStore = {
  listAgentRuns: () => readonly AgentRun[];
  updateAgentRun: (runId: string, patch: Partial<AgentRun>) => void;
};

interface CancelFeatureRunDeps {
  graph: Pick<FeatureGraph, 'tasks' | 'cancelFeature'>;
  store: AgentRunCancellationStore;
  runtime: Pick<RuntimePort, 'abortTask'>;
}

interface CancelTaskRunDeps {
  graph: Pick<FeatureGraph, 'tasks' | 'transitionTask'>;
  store: AgentRunCancellationStore;
  runtime: Pick<RuntimePort, 'abortTask'>;
}

interface CancelTaskCleanDeps extends CancelTaskRunDeps {
  worktree: Pick<WorktreeProvisioner, 'removeWorktree'>;
}

interface AbandonFeatureBranchDeps {
  graph: Pick<FeatureGraph, 'features' | 'tasks' | 'cancelFeature'>;
  store: AgentRunCancellationStore;
  runtime: Pick<RuntimePort, 'abortTask'>;
  worktree: Pick<WorktreeProvisioner, 'removeWorktree' | 'deleteBranch'>;
}

function listFeatureTasks(
  graph: Pick<FeatureGraph, 'tasks'>,
  featureId: FeatureId,
): Task[] {
  const tasks: Task[] = [];
  for (const task of graph.tasks.values()) {
    if (task.featureId === featureId) {
      tasks.push(task);
    }
  }
  return tasks;
}

function shouldAbortTaskRun(run: AgentRun): boolean {
  return (
    run.scopeType === 'task' &&
    (run.runStatus === 'running' ||
      run.runStatus === 'await_response' ||
      run.runStatus === 'await_approval')
  );
}

async function cancelTaskRuns(
  store: AgentRunCancellationStore,
  runtime: Pick<RuntimePort, 'abortTask'>,
  taskId: TaskId,
): Promise<void> {
  const runs = store
    .listAgentRuns()
    .filter((run) => run.scopeType === 'task' && run.scopeId === taskId);

  let abortSent = false;
  for (const run of runs) {
    if (!abortSent && shouldAbortTaskRun(run)) {
      await runtime.abortTask(taskId);
      abortSent = true;
    }
    store.updateAgentRun(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
    });
  }
}

export async function cancelTaskPreserveWorktree(
  deps: CancelTaskRunDeps,
  taskId: TaskId,
): Promise<void> {
  const task = deps.graph.tasks.get(taskId);
  if (task === undefined) {
    throw new Error(`task "${taskId}" does not exist`);
  }
  if (task.status === 'done') {
    throw new Error(`task "${taskId}" is already done`);
  }

  if (task.status !== 'cancelled') {
    deps.graph.transitionTask(taskId, { status: 'cancelled' });
  }
  await cancelTaskRuns(deps.store, deps.runtime, taskId);
}

export async function cancelTaskCleanWorktree(
  deps: CancelTaskCleanDeps,
  taskId: TaskId,
): Promise<void> {
  const task = deps.graph.tasks.get(taskId);
  if (task === undefined) {
    throw new Error(`task "${taskId}" does not exist`);
  }

  await cancelTaskPreserveWorktree(deps, taskId);
  await deps.worktree.removeWorktree(resolveTaskWorktreeBranch(task));
}

export async function cancelFeatureRunWork(
  deps: CancelFeatureRunDeps,
  featureId: FeatureId,
): Promise<void> {
  const { graph, store, runtime } = deps;

  const featureTaskIds = new Set<string>();
  for (const task of graph.tasks.values()) {
    if (task.featureId === featureId) {
      featureTaskIds.add(task.id);
    }
  }

  const affectedRuns = store.listAgentRuns().filter((run) => {
    if (run.scopeType === 'task') {
      return featureTaskIds.has(run.scopeId);
    }
    return run.scopeType === 'feature_phase' && run.scopeId === featureId;
  });

  graph.cancelFeature(featureId);

  for (const run of affectedRuns) {
    if (shouldAbortTaskRun(run)) {
      await runtime.abortTask(run.scopeId);
    }
    store.updateAgentRun(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
    });
  }
}

export async function abandonFeatureBranch(
  deps: AbandonFeatureBranchDeps,
  featureId: FeatureId,
): Promise<void> {
  const feature = deps.graph.features.get(featureId);
  if (feature === undefined) {
    throw new Error(`feature "${featureId}" does not exist`);
  }

  const tasks = listFeatureTasks(deps.graph, featureId);
  await cancelFeatureRunWork(deps, featureId);

  for (const task of tasks) {
    await deps.worktree.removeWorktree(resolveTaskWorktreeBranch(task));
  }
  await deps.worktree.removeWorktree(feature.featureBranch);

  for (const task of tasks) {
    await deps.worktree.deleteBranch(resolveTaskWorktreeBranch(task));
  }
  await deps.worktree.deleteBranch(feature.featureBranch);
}

export function summarizeApprovalPayload(payload: ApprovalPayload): string {
  switch (payload.kind) {
    case 'custom':
      return payload.label;
    case 'destructive_action':
      return payload.description;
    case 'replan_proposal':
      return payload.summary;
  }
}

function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'google':
    case 'gemini':
      return process.env.GEMINI_API_KEY;
    default:
      return undefined;
  }
}
