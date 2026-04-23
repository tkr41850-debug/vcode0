import {
  validateFeatureWorkTransition,
} from '@core/fsm/index';
import { describe, expect, it } from 'vitest';

// ── Work-control axis: legal transitions ────────────────────────────────
//
// Happy path from docs/architecture/data-model.md and ARCHITECTURE.md:
//   discussing → researching → planning → executing → ci_check → verifying
//   → awaiting_merge → summarizing → work_complete
//
// Repair branch:
//   executing | ci_check | verifying | awaiting_merge → executing_repair
//   executing_repair → executing | ci_check
//   executing_repair → replanning (repair failed)
//   verifying → replanning (structural failure)
//   replanning → executing | planning (replan succeeded)

describe('work-control axis — legal transitions (happy path)', () => {
  it.each([
    ['discussing', 'researching'],
    ['researching', 'planning'],
    ['planning', 'executing'],
    ['executing', 'ci_check'],
    ['ci_check', 'verifying'],
    ['verifying', 'awaiting_merge'],
    ['awaiting_merge', 'summarizing'],
    ['summarizing', 'work_complete'],
  ] as const)(
    '%s → %s with status=done and appropriate collab',
    (from, to) => {
      // verifying → awaiting_merge requires branch_open; awaiting_merge → summarizing requires merged
      const collab =
        from === 'awaiting_merge' ? 'merged' : 'branch_open';
      const result = validateFeatureWorkTransition(from, to, 'done', collab);
      expect(result.valid).toBe(true);
    },
  );
});

describe('work-control axis — budget-mode short-circuit', () => {
  it('awaiting_merge → work_complete with collab=merged (budget mode skip summarizing)', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'work_complete',
      'done',
      'merged',
    );
    expect(result.valid).toBe(true);
  });
});

describe('work-control axis — repair branch legal transitions', () => {
  it.each([
    ['executing', 'executing_repair', 'failed', 'branch_open'],
    ['ci_check', 'executing_repair', 'failed', 'branch_open'],
    ['verifying', 'executing_repair', 'failed', 'branch_open'],
    ['awaiting_merge', 'executing_repair', 'failed', 'branch_open'],
  ] as const)(
    'failure → repair: %s → %s (status=%s)',
    (from, to, status, collab) => {
      const result = validateFeatureWorkTransition(from, to, status, collab);
      expect(result.valid).toBe(true);
    },
  );

  it.each([
    ['executing_repair', 'executing', 'done', 'branch_open'],
    ['executing_repair', 'ci_check', 'done', 'branch_open'],
  ] as const)(
    'repair succeeded → return: %s → %s',
    (from, to, status, collab) => {
      const result = validateFeatureWorkTransition(from, to, status, collab);
      expect(result.valid).toBe(true);
    },
  );

  it('executing_repair → replanning (repair failed)', () => {
    const result = validateFeatureWorkTransition(
      'executing_repair',
      'replanning',
      'failed',
      'branch_open',
    );
    expect(result.valid).toBe(true);
  });

  it('verifying → replanning (structural failure)', () => {
    const result = validateFeatureWorkTransition(
      'verifying',
      'replanning',
      'failed',
      'branch_open',
    );
    expect(result.valid).toBe(true);
  });

  it.each([
    ['replanning', 'executing', 'done', 'branch_open'],
    ['replanning', 'planning', 'done', 'branch_open'],
  ] as const)(
    'replan succeeded → %s',
    (from, to, status, collab) => {
      const result = validateFeatureWorkTransition(from, to, status, collab);
      expect(result.valid).toBe(true);
    },
  );
});

describe('work-control axis — illegal transitions', () => {
  it('repair cannot skip ci_check and return directly to verifying', () => {
    const result = validateFeatureWorkTransition(
      'executing_repair',
      'verifying',
      'done',
      'branch_open',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBeTruthy();
    }
  });

  it.each([
    ['discussing', 'work_complete', 'done', 'none'],
    ['discussing', 'executing', 'done', 'none'],
    ['planning', 'work_complete', 'done', 'none'],
    ['executing', 'discussing', 'done', 'branch_open'],
    ['work_complete', 'discussing', 'done', 'merged'],
    ['summarizing', 'executing', 'done', 'merged'],
  ] as const)(
    'illegal: %s → %s',
    (from, to, status, collab) => {
      const result = validateFeatureWorkTransition(from, to, status, collab);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    },
  );

  it('no-op transition is rejected', () => {
    const result = validateFeatureWorkTransition(
      'executing',
      'executing',
      'done',
      'branch_open',
    );
    expect(result.valid).toBe(false);
  });

  it('cancelled feature cannot have work transitioned', () => {
    const result = validateFeatureWorkTransition(
      'executing',
      'ci_check',
      'done',
      'cancelled',
    );
    expect(result.valid).toBe(false);
  });

  it('conflict blocks phase advancement', () => {
    const result = validateFeatureWorkTransition(
      'ci_check',
      'verifying',
      'done',
      'conflict',
    );
    expect(result.valid).toBe(false);
  });

  it('verifying → awaiting_merge requires collab=branch_open', () => {
    const result = validateFeatureWorkTransition(
      'verifying',
      'awaiting_merge',
      'done',
      'merge_queued',
    );
    expect(result.valid).toBe(false);
  });

  it('awaiting_merge → summarizing requires collab=merged', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'summarizing',
      'done',
      'branch_open',
    );
    expect(result.valid).toBe(false);
  });
});
