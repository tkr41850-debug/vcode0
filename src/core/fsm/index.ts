import type {
  FeatureCollabControl,
  FeatureWorkControl,
  TaskCollabControl,
  TaskStatus,
  UnitStatus,
} from '@core/types/index';

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
  'feature_ci',
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
  'feature_ci',
  'verifying',
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

  // Failure → repair (caller checks attempt count)
  if (
    proposed === 'executing_repair' &&
    REPAIRABLE_PHASES.has(current) &&
    FAILURE_STATUSES.has(status)
  ) {
    return { valid: true };
  }

  // Repair succeeded → return to executing or feature_ci.
  // Repair always re-enters through feature_ci (not verifying directly),
  // because CI must re-validate after any code change. If the original
  // failure was in executing, return to executing to finish remaining work.
  if (
    current === 'executing_repair' &&
    (proposed === 'executing' || proposed === 'feature_ci') &&
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

  // Replan succeeded → re-execute
  if (
    current === 'replanning' &&
    proposed === 'executing' &&
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

  // Branch opens only on the first phase
  if (proposed === 'branch_open' && current === 'none') {
    if (workControl !== 'discussing') {
      return {
        valid: false,
        reason: 'branch_open from none only valid during discussing phase',
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
  ['running', new Set(['done', 'failed', 'stuck', 'cancelled'])],
  ['stuck', new Set(['running', 'failed', 'cancelled'])],
  // Terminal: done, failed, cancelled
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
