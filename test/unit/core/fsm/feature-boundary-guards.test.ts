import { validateFeatureWorkTransition } from '@core/fsm/index';
import { describe, expect, it } from 'vitest';

/**
 * Plan 05-02 Task 3 — boundary-guard reason strings.
 *
 * `validateFeatureWorkTransition` is the single chokepoint that enforces
 * Phase-5's two collab-coupled boundary guards:
 *
 *   (A) `verifying → awaiting_merge` requires `collabControl='branch_open'`
 *       — the feature must still hold its branch when handing off to the
 *       merge train. A feature in `conflict` / `cancelled` / `merge_queued`
 *       must settle first.
 *
 *   (B) `awaiting_merge → summarizing` requires `collabControl='merged'`
 *       — the feature must have actually landed on main before the
 *       summarizer agent runs. Letting a `branch_open` or `conflict`
 *       feature summarize would produce a misleading record.
 *
 *       The same invariant gates the budget-mode short-circuit
 *       `awaiting_merge → work_complete`.
 *
 * These tests assert each guard's exact `reason` string so downstream
 * consumers (scheduler logs, TUI error surfaces, replan diagnostics) can
 * reliably pattern-match on the failure. A message change is a contract
 * change and must be reflected here.
 */

describe('feature work-control boundary guards — verifying → awaiting_merge', () => {
  it('rejects when collabControl is not branch_open', () => {
    // `conflict` is handled by the earlier "cannot advance during
    // conflict" guard; pick a non-conflict, non-branch_open collab so
    // the boundary-specific reason is exercised.
    const result = validateFeatureWorkTransition(
      'verifying',
      'awaiting_merge',
      'done',
      'merge_queued',
    );
    expect(result).toEqual({
      valid: false,
      reason: 'verifying → awaiting_merge requires collabControl=branch_open',
    });
  });

  it('accepts when collabControl=branch_open and status=done', () => {
    const result = validateFeatureWorkTransition(
      'verifying',
      'awaiting_merge',
      'done',
      'branch_open',
    );
    expect(result).toEqual({ valid: true });
  });
});

describe('feature work-control boundary guards — awaiting_merge → summarizing', () => {
  it('rejects when collabControl is not merged (happy-path advance)', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'summarizing',
      'done',
      'branch_open',
    );
    expect(result).toEqual({
      valid: false,
      reason: 'awaiting_merge → summarizing requires collabControl=merged',
    });
  });

  it('accepts when collabControl=merged and status=done', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'summarizing',
      'done',
      'merged',
    );
    expect(result).toEqual({ valid: true });
  });
});

describe('feature work-control boundary guards — awaiting_merge → work_complete (budget-mode)', () => {
  it('rejects the budget-mode short-circuit when collabControl is not merged', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'work_complete',
      'done',
      'branch_open',
    );
    expect(result).toEqual({
      valid: false,
      reason: 'awaiting_merge → work_complete requires collabControl=merged',
    });
  });

  it('accepts the budget-mode short-circuit when collabControl=merged', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'work_complete',
      'done',
      'merged',
    );
    expect(result).toEqual({ valid: true });
  });
});
