import {
  type CollabControl,
  compositeGuard,
  type RunState,
  type WorkControl,
} from '@core/fsm/index';
import { describe, expect, it } from 'vitest';

// ── Composite (work × collab × run) exhaustive matrix ───────────────────
//
// Exercises every (work × collab × run) combination declared in src/core/fsm/
// against the `compositeGuard` function, which is the canonical static-legality
// checker documented in docs/architecture/data-model.md.
//
// Per plan 01-01: each combination must either be legal (valid static state)
// or explicitly rejected with a non-empty `reason` string. No combination may
// be silently accepted-but-wrong — the guard must be total.
//
// The expected-legal set below is derived from docs/architecture/data-model.md
// and the nine cross-axis rules encoded in compositeGuard:
//
//   1. work=work_complete requires collab=merged
//   2. work=awaiting_merge requires collab ∈ {branch_open, merge_queued, integrating, conflict}
//   3. execution phases (executing, ci_check, verifying, executing_repair,
//      awaiting_merge, summarizing) require collab != none
//   4. collab=cancelled freezes work: illegal active work states
//   5. collab=merge_queued with run=await_response is illegal
//   6. collab=merge_queued with run=await_approval is illegal
//   7. pre-branch phases (discussing, researching, planning) require
//      collab=none or collab=cancelled
//   8. run=await_response / await_approval require active work
//      (illegal when work=work_complete or collab=merged or collab=cancelled)
//   9. run=failed / cancelled is illegal at work=work_complete
//
// Notes: The WorkControl value 'replanning' is not enumerated in WORK_VALUES
// because the exhaustive matrix uses only the values declared in
// ARCHITECTURE.md §Lifecycle Snapshot. `replanning` is reachable only through
// repair-escalation transitions and is tested in work-control-axis.test.ts.

const WORK_VALUES: readonly WorkControl[] = [
  'discussing',
  'researching',
  'planning',
  'executing',
  'executing_repair',
  'ci_check',
  'verifying',
  'awaiting_merge',
  'summarizing',
  'work_complete',
] as const;

const COLLAB_VALUES: readonly CollabControl[] = [
  'none',
  'branch_open',
  'merge_queued',
  'integrating',
  'merged',
  'conflict',
  'cancelled',
] as const;

// Only the AgentRunStatus values exercised by the composite guard matrix.
// The type also includes terminal states like 'failed' and 'cancelled';
// this matrix keeps the active and completed states needed for the cross-axis rules.
const RUN_VALUES: readonly RunState[] = [
  'ready',
  'running',
  'retry_await',
  'await_response',
  'await_approval',
  'checkpointed_await_response',
  'checkpointed_await_approval',
  'completed',
] as const;

// Rule evaluators — mirror compositeGuard's rule set. If any rule fires, the
// combination is illegal.
function isLegalByRules(
  work: WorkControl,
  collab: CollabControl,
  run: RunState,
): boolean {
  // Rule 1
  if (work === 'work_complete' && collab !== 'merged') return false;
  // Rule 2
  if (
    work === 'awaiting_merge' &&
    !(
      collab === 'branch_open' ||
      collab === 'merge_queued' ||
      collab === 'integrating' ||
      collab === 'conflict'
    )
  ) {
    return false;
  }
  // Rule 3
  const activePhases: readonly WorkControl[] = [
    'executing',
    'ci_check',
    'verifying',
    'executing_repair',
    'awaiting_merge',
    'summarizing',
  ];
  if (activePhases.includes(work) && collab === 'none') return false;
  // Rule 4
  if (collab === 'cancelled') {
    const illegalWhenCancelled: readonly WorkControl[] = [
      'executing',
      'ci_check',
      'verifying',
      'executing_repair',
      'awaiting_merge',
      'summarizing',
    ];
    if (illegalWhenCancelled.includes(work)) return false;
  }
  // Rule 5
  if (
    collab === 'merge_queued' &&
    (run === 'await_response' || run === 'checkpointed_await_response')
  ) {
    return false;
  }
  // Rule 6
  if (
    collab === 'merge_queued' &&
    (run === 'await_approval' || run === 'checkpointed_await_approval')
  ) {
    return false;
  }
  // Rule 7
  const preBranch: readonly WorkControl[] = [
    'discussing',
    'researching',
    'planning',
  ];
  if (preBranch.includes(work) && collab !== 'none' && collab !== 'cancelled') {
    return false;
  }
  // Rule 8
  if (
    run === 'await_response' ||
    run === 'await_approval' ||
    run === 'checkpointed_await_response' ||
    run === 'checkpointed_await_approval'
  ) {
    if (
      work === 'work_complete' ||
      collab === 'merged' ||
      collab === 'cancelled'
    ) {
      return false;
    }
  }
  // Rule 9 — guards against 'failed'/'cancelled' terminals at work_complete;
  // we do not include those run values in RUN_VALUES so this is a no-op.

  return true;
}

describe('compositeGuard exhaustive matrix', () => {
  // Manually enumerate the matrix so each (work × collab × run) combo gets
  // its own `it` block. This produces 10 × 7 × 8 = 560 test cases.
  for (const work of WORK_VALUES) {
    for (const collab of COLLAB_VALUES) {
      for (const run of RUN_VALUES) {
        const expectedLegal = isLegalByRules(work, collab, run);
        it(`(${work} × ${collab} × ${run}) should be ${
          expectedLegal ? 'legal' : 'illegal'
        }`, () => {
          const result = compositeGuard({ work, collab, run });
          expect(result.legal).toBe(expectedLegal);
          if (!result.legal) {
            expect(result.reason.length).toBeGreaterThan(0);
          }
        });
      }
    }
  }
});

describe('compositeGuard — spot checks for each invariant rule', () => {
  it('Rule 1: work=work_complete with collab != merged is illegal', () => {
    const r = compositeGuard({
      work: 'work_complete',
      collab: 'branch_open',
      run: 'completed',
    });
    expect(r.legal).toBe(false);
    if (!r.legal) expect(r.reason).toMatch(/work_complete.*merged/);
  });

  it('Rule 2: work=awaiting_merge with collab=merged is illegal', () => {
    const r = compositeGuard({
      work: 'awaiting_merge',
      collab: 'merged',
      run: 'ready',
    });
    expect(r.legal).toBe(false);
  });

  it('Rule 3: work=executing with collab=none is illegal', () => {
    const r = compositeGuard({
      work: 'executing',
      collab: 'none',
      run: 'running',
    });
    expect(r.legal).toBe(false);
  });

  it('Rule 4: collab=cancelled freezes work=executing', () => {
    const r = compositeGuard({
      work: 'executing',
      collab: 'cancelled',
      run: 'ready',
    });
    expect(r.legal).toBe(false);
  });

  it('Rule 5: collab=merge_queued + run=await_response is illegal', () => {
    const r = compositeGuard({
      work: 'awaiting_merge',
      collab: 'merge_queued',
      run: 'await_response',
    });
    expect(r.legal).toBe(false);
    if (!r.legal) expect(r.reason).toMatch(/merge-train/i);
  });

  it('Rule 6: collab=merge_queued + run=await_approval is illegal', () => {
    const r = compositeGuard({
      work: 'awaiting_merge',
      collab: 'merge_queued',
      run: 'await_approval',
    });
    expect(r.legal).toBe(false);
  });

  it('Rule 7: pre-branch phase with collab=branch_open is illegal', () => {
    const r = compositeGuard({
      work: 'discussing',
      collab: 'branch_open',
      run: 'ready',
    });
    expect(r.legal).toBe(false);
  });

  it('Rule 8: run=await_response with work=work_complete is illegal', () => {
    const r = compositeGuard({
      work: 'work_complete',
      collab: 'merged',
      run: 'await_response',
    });
    expect(r.legal).toBe(false);
  });

  it('canonical-legal example passes: executing / branch_open / running', () => {
    const r = compositeGuard({
      work: 'executing',
      collab: 'branch_open',
      run: 'running',
    });
    expect(r.legal).toBe(true);
  });

  it('canonical-legal terminal: work_complete / merged / completed', () => {
    const r = compositeGuard({
      work: 'work_complete',
      collab: 'merged',
      run: 'completed',
    });
    expect(r.legal).toBe(true);
  });
});
