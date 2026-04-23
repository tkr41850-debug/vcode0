import type {
  AgentRunStatus,
  FeatureCollabControl,
  FeatureWorkControl,
  TaskCollabControl,
  TaskStatus,
  UnitStatus,
} from '@core/types/index';

// ── Composite-guard axis type aliases ────────────────────────────────────

/**
 * Work control axis: tracks planning / execution phase progression.
 * Alias for FeatureWorkControl — the same type, named for composite-guard clarity.
 */
export type WorkControl = FeatureWorkControl;

/**
 * Collaboration control axis: tracks branch / merge / conflict coordination.
 * Alias for FeatureCollabControl — the same type, named for composite-guard clarity.
 */
export type CollabControl = FeatureCollabControl;

/**
 * Run state axis: tracks retry, help, approval, and manual overlays on agent_runs.
 * Maps to AgentRunStatus — the per-run execution disposition.
 */
export type RunState = AgentRunStatus;

// ── Composite-guard types ────────────────────────────────────────────────

export type CompositeState = {
  readonly work: WorkControl;
  readonly collab: CollabControl;
  readonly run: RunState;
};

export type CompositeGuardResult =
  | { readonly legal: true }
  | { readonly legal: false; readonly reason: string };

// ── Constants ───────────────────────────────────────────────────────────

// ── Run-state axis (AgentRunStatus transitions) ──────────────────────────

/**
 * Valid outbound transitions for each AgentRunStatus.
 *
 * Semantics:
 * - ready: an agent run is queued but not yet dispatched
 * - running: agent process is active
 * - retry_await: transient failure — waiting for retry window to expire
 * - await_response: waiting for human input (help request)
 * - await_approval: waiting for user approval of a proposed action
 * - completed: terminal — run finished successfully
 * - failed: terminal — run finished with an unrecoverable failure
 * - cancelled: terminal — run was cancelled
 *
 * Note: `manual` is not a RunStatus value — manual ownership is tracked
 * separately via RunOwner on the agent_runs row.
 */
const RUN_STATE_TRANSITIONS = new Map<AgentRunStatus, ReadonlySet<AgentRunStatus>>([
  ['ready', new Set(['running', 'cancelled'])],
  ['running', new Set(['retry_await', 'await_response', 'await_approval', 'completed', 'failed', 'cancelled'])],
  ['retry_await', new Set(['ready', 'running', 'cancelled'])],
  ['await_response', new Set(['ready', 'running', 'cancelled'])],
  ['await_approval', new Set(['ready', 'running', 'cancelled'])],
  // Terminal states: no outbound transitions
]);

/**
 * Validates a run-state (AgentRunStatus) transition.
 * Returns { valid: true } for legal transitions, { valid: false, reason } for illegal ones.
 */
export function validateRunStateTransition(
  current: RunState,
  proposed: RunState,
): TransitionResult {
  if (current === proposed) {
    return { valid: false, reason: `no-op run-state transition: ${current}` };
  }

  const terminal: RunState[] = ['completed', 'failed', 'cancelled'];
  if (terminal.includes(current)) {
    return {
      valid: false,
      reason: `run-state ${current} is terminal — no outbound transitions allowed`,
    };
  }

  const allowed = RUN_STATE_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `illegal run-state transition: ${current} → ${proposed}`,
    };
  }

  return { valid: true };
}

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Maximum repair attempts before escalating to replan.
 * See feature candidate: extended-repair-profiles.md for profile-aware tuning.
 */
export const MAX_REPAIR_ATTEMPTS = 1;

// ── Result type ─────────────────────────────────────────────────────────

export type TransitionResult =
  | { valid: true }
  | { valid: false; reason: string };

// ── Feature state triple ────────────────────────────────────────────────

export interface FeatureStateTriple {
  workControl: FeatureWorkControl;
  status: UnitStatus;
  collabControl: FeatureCollabControl;
}

// ── Feature work control ────────────────────────────────────────────────

// Happy-path phase order. Each phase advances to the next when status=done.
const PHASE_ORDER: readonly FeatureWorkControl[] = [
  'discussing',
  'researching',
  'planning',
  'executing',
  'ci_check',
  'verifying',
  'awaiting_merge',
  'summarizing',
  'work_complete',
];

function nextPhase(
  current: FeatureWorkControl,
): FeatureWorkControl | undefined {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx === PHASE_ORDER.length - 1) return undefined;
  return PHASE_ORDER[idx + 1];
}

// Phases where failure triggers the repair→replan escalation ladder.
const REPAIRABLE_PHASES = new Set<FeatureWorkControl>([
  'executing',
  'ci_check',
  'verifying',
  'awaiting_merge',
]);

const FAILURE_STATUSES = new Set<UnitStatus>(['failed']);

/**
 * Validates a workControl transition given the current status and collabControl.
 *
 * Caller responsibilities (this guard validates structural legality only):
 * - Repair attempt counting: check attempts < MAX_REPAIR_ATTEMPTS before
 *   proposing a transition to executing_repair.
 * - Replan cycle tracking: after replanning→executing, a subsequent failure
 *   should be a hard stop (surface to user), not another repair/replan cycle.
 *   The FSM has no history — the caller must enforce the one-replan limit.
 */
export function validateFeatureWorkTransition(
  current: FeatureWorkControl,
  proposed: FeatureWorkControl,
  status: UnitStatus,
  collabControl: FeatureCollabControl,
): TransitionResult {
  if (current === proposed) {
    return {
      valid: false,
      reason: `no-op transition: ${current} → ${proposed}`,
    };
  }

  if (collabControl === 'cancelled' || status === 'cancelled') {
    return {
      valid: false,
      reason: 'cannot transition workControl when cancelled',
    };
  }

  // Happy path: advance to next phase when done.
  // Conflict blocks advancement — resolve the conflict first.
  if (proposed === nextPhase(current) && status === 'done') {
    if (collabControl === 'conflict') {
      return {
        valid: false,
        reason: 'cannot advance phase during conflict',
      };
    }
    if (current === 'verifying' && collabControl !== 'branch_open') {
      return {
        valid: false,
        reason: 'verifying → awaiting_merge requires collabControl=branch_open',
      };
    }
    if (current === 'awaiting_merge' && collabControl !== 'merged') {
      return {
        valid: false,
        reason: 'awaiting_merge → summarizing requires collabControl=merged',
      };
    }
    return { valid: true };
  }

  if (
    current === 'awaiting_merge' &&
    proposed === 'work_complete' &&
    status === 'done'
  ) {
    if (collabControl !== 'merged') {
      return {
        valid: false,
        reason: 'awaiting_merge → work_complete requires collabControl=merged',
      };
    }
    return { valid: true };
  }

  // Failure → repair (caller checks attempt count)
  if (
    proposed === 'executing_repair' &&
    REPAIRABLE_PHASES.has(current) &&
    FAILURE_STATUSES.has(status)
  ) {
    return { valid: true };
  }

  // Repair succeeded → return to executing or ci_check.
  // Repair always re-enters through ci_check (not verifying directly),
  // because CI must re-validate after any code change. If the original
  // failure was in executing, return to executing to finish remaining work.
  if (
    current === 'executing_repair' &&
    (proposed === 'executing' || proposed === 'ci_check') &&
    status === 'done'
  ) {
    return { valid: true };
  }

  // Repair failed → escalate to replan
  if (
    current === 'executing_repair' &&
    proposed === 'replanning' &&
    FAILURE_STATUSES.has(status)
  ) {
    return { valid: true };
  }

  // Verify failure (typed issues or !ok) → replanner decides fixes.
  if (
    current === 'verifying' &&
    proposed === 'replanning' &&
    FAILURE_STATUSES.has(status)
  ) {
    return { valid: true };
  }

  // Replan succeeded → re-plan or re-execute
  if (
    current === 'replanning' &&
    (proposed === 'planning' || proposed === 'executing') &&
    status === 'done'
  ) {
    return { valid: true };
  }

  // replanning/failed is an intentional dead end — no outbound workControl
  // transition exists. The feature requires user intervention to proceed.

  return {
    valid: false,
    reason: `illegal workControl transition: ${current}(${status}) → ${proposed}`,
  };
}

// ── Feature status ──────────────────────────────────────────────────────

const STATUS_TRANSITIONS = new Map<UnitStatus, ReadonlySet<UnitStatus>>([
  ['pending', new Set(['in_progress', 'cancelled'])],
  ['in_progress', new Set(['done', 'failed', 'cancelled'])],
  // Terminal: done, failed, cancelled — no outbound transitions
]);

export function validateFeatureStatusTransition(
  current: UnitStatus,
  proposed: UnitStatus,
  workControl: FeatureWorkControl,
  collabControl: FeatureCollabControl,
): TransitionResult {
  if (current === proposed) {
    return { valid: false, reason: `no-op status transition: ${current}` };
  }

  if (collabControl === 'cancelled' && proposed !== 'cancelled') {
    return {
      valid: false,
      reason: 'only cancelled status allowed when collabControl=cancelled',
    };
  }

  // work_complete is terminal — status must stay done
  if (workControl === 'work_complete') {
    return {
      valid: false,
      reason: 'work_complete phase status cannot transition',
    };
  }

  const allowed = STATUS_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `illegal status transition: ${current} → ${proposed}`,
    };
  }

  return { valid: true };
}

// ── Feature collab control ──────────────────────────────────────────────

const COLLAB_TRANSITIONS = new Map<
  FeatureCollabControl,
  ReadonlySet<FeatureCollabControl>
>([
  ['none', new Set(['branch_open', 'cancelled'])],
  ['branch_open', new Set(['merge_queued', 'conflict', 'cancelled'])],
  ['merge_queued', new Set(['integrating', 'branch_open', 'cancelled'])],
  ['integrating', new Set(['merged', 'conflict', 'cancelled'])],
  ['conflict', new Set(['branch_open', 'merge_queued', 'cancelled'])],
  // Terminal: merged, cancelled — no outbound transitions
]);

export function validateFeatureCollabTransition(
  current: FeatureCollabControl,
  proposed: FeatureCollabControl,
  workControl: FeatureWorkControl,
  _status: UnitStatus,
): TransitionResult {
  if (current === proposed) {
    return { valid: false, reason: `no-op collab transition: ${current}` };
  }

  // Branch opens when planning approval advances the feature into execution.
  if (proposed === 'branch_open' && current === 'none') {
    if (workControl !== 'executing') {
      return {
        valid: false,
        reason: 'branch_open from none only valid during executing phase',
      };
    }
  }

  // Enter merge queue: the composite guard passes proposed workControl/status,
  // so after work advances from verifying→awaiting_merge we see awaiting_merge/pending.
  if (proposed === 'merge_queued' && current === 'branch_open') {
    if (workControl !== 'awaiting_merge') {
      return {
        valid: false,
        reason:
          'merge_queued from branch_open requires workControl=awaiting_merge',
      };
    }
  }

  // Conflict re-entry to merge queue only from awaiting_merge
  if (proposed === 'merge_queued' && current === 'conflict') {
    if (workControl !== 'awaiting_merge') {
      return {
        valid: false,
        reason:
          'conflict → merge_queued only valid during awaiting_merge (integration conflict resolved)',
      };
    }
  }

  // Dequeue from merge_queued back to branch_open (repair ejection)
  if (proposed === 'branch_open' && current === 'merge_queued') {
    if (workControl !== 'awaiting_merge') {
      return {
        valid: false,
        reason: 'merge_queued → branch_open only valid during awaiting_merge',
      };
    }
  }

  const allowed = COLLAB_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `illegal collab transition: ${current} → ${proposed}`,
    };
  }

  return { valid: true };
}

// ── Feature composite guard ─────────────────────────────────────────────

/**
 * Validates a full state triple transition. Handles multi-axis transitions
 * (e.g. verifying/done/branch_open → awaiting_merge/pending/merge_queued)
 * by checking each changed axis in order: workControl, then status, then collab.
 *
 * When workControl advances, status must reset to 'pending'
 * (or 'done' for terminal work_complete).
 */
export function validateFeatureTransition(
  current: FeatureStateTriple,
  proposed: FeatureStateTriple,
): TransitionResult {
  const workChanged = current.workControl !== proposed.workControl;
  const statusChanged = current.status !== proposed.status;
  const collabChanged = current.collabControl !== proposed.collabControl;

  if (!workChanged && !statusChanged && !collabChanged) {
    return { valid: false, reason: 'no-op: nothing changed' };
  }

  // ── Work control axis ──
  if (workChanged) {
    const result = validateFeatureWorkTransition(
      current.workControl,
      proposed.workControl,
      current.status,
      current.collabControl,
    );
    if (!result.valid) return result;

    // Phase advancement resets status to pending (terminal is done)
    const expectedStatus =
      proposed.workControl === 'work_complete' ? 'done' : 'pending';
    if (proposed.status !== expectedStatus) {
      return {
        valid: false,
        reason: `status must be '${expectedStatus}' after advancing to ${proposed.workControl}, got '${proposed.status}'`,
      };
    }
  }

  // ── Status axis (only for within-phase changes) ──
  if (statusChanged && !workChanged) {
    const result = validateFeatureStatusTransition(
      current.status,
      proposed.status,
      current.workControl,
      current.collabControl,
    );
    if (!result.valid) return result;
  }

  // ── Collab control axis ──
  if (collabChanged) {
    const result = validateFeatureCollabTransition(
      current.collabControl,
      proposed.collabControl,
      // Use proposed work/status since those axes may have changed above
      proposed.workControl,
      proposed.status,
    );
    if (!result.valid) return result;
  }

  return { valid: true };
}

// ── Task status ─────────────────────────────────────────────────────────

const TASK_STATUS_TRANSITIONS = new Map<TaskStatus, ReadonlySet<TaskStatus>>([
  ['pending', new Set(['ready', 'cancelled'])],
  ['ready', new Set(['running', 'cancelled'])],
  ['running', new Set(['ready', 'done', 'failed', 'stuck', 'cancelled'])],
  ['stuck', new Set(['ready', 'running', 'failed', 'cancelled'])],
  ['failed', new Set(['cancelled'])],
  // Terminal: done, cancelled
]);

export function validateTaskStatusTransition(
  current: TaskStatus,
  proposed: TaskStatus,
  collabControl: TaskCollabControl,
): TransitionResult {
  if (current === proposed) {
    return { valid: false, reason: `no-op task status transition: ${current}` };
  }

  // Cannot resume running while suspended
  if (proposed === 'running' && collabControl === 'suspended') {
    return { valid: false, reason: 'cannot start running while suspended' };
  }

  const allowed = TASK_STATUS_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `illegal task status transition: ${current} → ${proposed}`,
    };
  }

  return { valid: true };
}

// ── Task collab control ─────────────────────────────────────────────────

const TASK_COLLAB_TRANSITIONS = new Map<
  TaskCollabControl,
  ReadonlySet<TaskCollabControl>
>([
  ['none', new Set(['branch_open'])],
  ['branch_open', new Set(['merged', 'conflict', 'suspended'])],
  ['conflict', new Set(['branch_open'])],
  ['suspended', new Set(['branch_open'])],
  // Terminal: merged
]);

export function validateTaskCollabTransition(
  current: TaskCollabControl,
  proposed: TaskCollabControl,
  taskStatus: TaskStatus,
): TransitionResult {
  if (current === proposed) {
    return {
      valid: false,
      reason: `no-op task collab transition: ${current}`,
    };
  }

  // Cancelled tasks cannot have collab changed
  if (taskStatus === 'cancelled') {
    return {
      valid: false,
      reason: 'cannot transition collab on a cancelled task',
    };
  }

  // Can only suspend a running task
  if (proposed === 'suspended' && taskStatus !== 'running') {
    return { valid: false, reason: 'can only suspend a running task' };
  }

  // Can only merge a completed task
  if (proposed === 'merged' && taskStatus !== 'done') {
    return { valid: false, reason: 'can only merge a completed task' };
  }

  const allowed = TASK_COLLAB_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `illegal task collab transition: ${current} → ${proposed}`,
    };
  }

  return { valid: true };
}

// ── Task composite guard ───────────────────────────────────────────────

export interface TaskStatePair {
  status: TaskStatus;
  collabControl: TaskCollabControl;
}

/**
 * Validates a full task state-pair transition. Checks each changed axis
 * in order: status first, then collab (using proposed status for collab
 * validation so multi-axis transitions like done+merged work correctly).
 */
export function validateTaskTransition(
  current: TaskStatePair,
  proposed: TaskStatePair,
): TransitionResult {
  const statusChanged = current.status !== proposed.status;
  const collabChanged = current.collabControl !== proposed.collabControl;

  if (!statusChanged && !collabChanged) {
    return { valid: false, reason: 'no-op: nothing changed' };
  }

  if (statusChanged) {
    const result = validateTaskStatusTransition(
      current.status,
      proposed.status,
      current.collabControl,
    );
    if (!result.valid) return result;
  }

  if (collabChanged) {
    const result = validateTaskCollabTransition(
      current.collabControl,
      proposed.collabControl,
      proposed.status,
    );
    if (!result.valid) return result;
  }

  return { valid: true };
}

// ── Cross-axis composite invariants ─────────────────────────────────────

/**
 * Terminal work-complete requires collab=merged (feature is fully done only
 * when both axes reach their terminal states).
 */
function checkWorkCompleteRequiresMerged(
  state: CompositeState,
): CompositeGuardResult {
  if (state.work === 'work_complete' && state.collab !== 'merged') {
    return {
      legal: false,
      reason: `work_complete requires collab=merged, got collab=${state.collab}`,
    };
  }
  return { legal: true };
}

/**
 * awaiting_merge requires collab ∈ {branch_open, merge_queued, integrating, conflict}.
 * The feature cannot be awaiting merge if collab is none, merged, or cancelled.
 */
function checkAwaitingMergeCollabConstraint(
  state: CompositeState,
): CompositeGuardResult {
  if (state.work === 'awaiting_merge') {
    const validCollab: CollabControl[] = [
      'branch_open',
      'merge_queued',
      'integrating',
      'conflict',
    ];
    if (!validCollab.includes(state.collab)) {
      return {
        legal: false,
        reason: `awaiting_merge requires collab ∈ {branch_open, merge_queued, integrating, conflict}, got collab=${state.collab}`,
      };
    }
  }
  return { legal: true };
}

/**
 * Execution phases (executing, ci_check, verifying, executing_repair, awaiting_merge,
 * summarizing) require collab != none (a branch must exist for active work).
 */
function checkActiveWorkRequiresBranch(
  state: CompositeState,
): CompositeGuardResult {
  const activePhasesRequiringBranch: WorkControl[] = [
    'executing',
    'ci_check',
    'verifying',
    'executing_repair',
    'awaiting_merge',
    'summarizing',
  ];
  if (
    activePhasesRequiringBranch.includes(state.work) &&
    state.collab === 'none'
  ) {
    return {
      legal: false,
      reason: `work=${state.work} requires collab != none (branch must exist)`,
    };
  }
  return { legal: true };
}

/**
 * Cancelled collab means the feature is fully cancelled — work must be frozen.
 * No active execution states are legal when collab=cancelled.
 */
function checkCancelledCollabFreezeWork(
  state: CompositeState,
): CompositeGuardResult {
  if (state.collab === 'cancelled') {
    const illegalWorkWhenCancelled: WorkControl[] = [
      'executing',
      'ci_check',
      'verifying',
      'executing_repair',
      'awaiting_merge',
      'summarizing',
      'replanning',
    ];
    if (illegalWorkWhenCancelled.includes(state.work)) {
      return {
        legal: false,
        reason: `collab=cancelled freezes work; work=${state.work} is not allowed`,
      };
    }
  }
  return { legal: true };
}

/**
 * merge_queued collab with run=await_response is illegal.
 * A feature waiting for a human response cannot be actively integrating.
 * (An agent run waiting for user input cannot hold a merge-train position.)
 */
function checkMergeQueuedNoAwaitResponse(
  state: CompositeState,
): CompositeGuardResult {
  if (state.collab === 'merge_queued' && state.run === 'await_response') {
    return {
      legal: false,
      reason:
        'collab=merge_queued with run=await_response is illegal — cannot hold merge-train slot while waiting for human input',
    };
  }
  return { legal: true };
}

/**
 * merge_queued collab with run=await_approval is illegal for the same reason.
 */
function checkMergeQueuedNoAwaitApproval(
  state: CompositeState,
): CompositeGuardResult {
  if (state.collab === 'merge_queued' && state.run === 'await_approval') {
    return {
      legal: false,
      reason:
        'collab=merge_queued with run=await_approval is illegal — cannot hold merge-train slot while waiting for approval',
    };
  }
  return { legal: true };
}

/**
 * Pre-branch phases (discussing, researching, planning) must have collab=none.
 * No branch should be open before the feature reaches executing.
 */
function checkPreBranchPhasesRequireNoneCollab(
  state: CompositeState,
): CompositeGuardResult {
  const preBranchPhases: WorkControl[] = [
    'discussing',
    'researching',
    'planning',
  ];
  if (
    preBranchPhases.includes(state.work) &&
    state.collab !== 'none' &&
    state.collab !== 'cancelled'
  ) {
    return {
      legal: false,
      reason: `work=${state.work} (pre-branch phase) requires collab=none or collab=cancelled, got collab=${state.collab}`,
    };
  }
  return { legal: true };
}

/**
 * Run states await_response, await_approval are only meaningful on active runs.
 * They are illegal when work=work_complete or collab=merged or collab=cancelled.
 */
function checkWaitRunStatesRequireActiveWork(
  state: CompositeState,
): CompositeGuardResult {
  const waitStates: RunState[] = ['await_response', 'await_approval'];
  if (waitStates.includes(state.run)) {
    if (
      state.work === 'work_complete' ||
      state.collab === 'merged' ||
      state.collab === 'cancelled'
    ) {
      return {
        legal: false,
        reason: `run=${state.run} is illegal when work=${state.work}, collab=${state.collab} (no active agent run expected)`,
      };
    }
  }
  return { legal: true };
}

/**
 * run=completed or run=failed or run=cancelled are transient terminal states
 * on individual runs and should not persist as the current run state when
 * work_complete has been reached. These are legal intermediately but flag
 * as illegal when combined with pre-execution phases having active run state.
 *
 * For the composite guard, terminal run states (completed, failed, cancelled)
 * are legal in almost all work/collab combinations — they represent "no run
 * currently active." The exception: run=failed or run=cancelled cannot
 * coexist with work=work_complete because a completed feature should not have
 * a failed/cancelled run as the latest state.
 */
function checkTerminalRunStateWithWorkComplete(
  state: CompositeState,
): CompositeGuardResult {
  if (
    state.work === 'work_complete' &&
    (state.run === 'failed' || state.run === 'cancelled')
  ) {
    return {
      legal: false,
      reason: `run=${state.run} is illegal at work_complete — completed features must not have failed/cancelled run states`,
    };
  }
  return { legal: true };
}

/**
 * Validates a composite (work × collab × run) state against all cross-axis
 * invariants documented in docs/architecture/data-model.md.
 *
 * Each rule is a named internal function so the composite-invariants test can
 * identify which specific rule triggered a rejection.
 *
 * This guard validates *static* state legality (is this combination of values
 * a valid state to be in?), not transition legality (is moving from A to B
 * allowed?). For transition validation, use the per-axis guards.
 */
export function compositeGuard(state: CompositeState): CompositeGuardResult {
  const rules = [
    checkWorkCompleteRequiresMerged,
    checkAwaitingMergeCollabConstraint,
    checkActiveWorkRequiresBranch,
    checkCancelledCollabFreezeWork,
    checkMergeQueuedNoAwaitResponse,
    checkMergeQueuedNoAwaitApproval,
    checkPreBranchPhasesRequireNoneCollab,
    checkWaitRunStatesRequireActiveWork,
    checkTerminalRunStateWithWorkComplete,
  ];

  for (const rule of rules) {
    const result = rule(state);
    if (!result.legal) return result;
  }

  return { legal: true };
}
