import {
  validateFeatureCollabTransition,
} from '@core/fsm/index';
import { describe, expect, it } from 'vitest';

// ── Collab-control axis: legal transitions ──────────────────────────────
//
// From docs/architecture/data-model.md and ARCHITECTURE.md:
//   none → branch_open → merge_queued → integrating → merged
//                              ↓
//                           conflict
//
//   branch_open / merge_queued / conflict → cancelled

describe('collab-control axis — happy path legal transitions', () => {
  it('none → branch_open (feature starts executing)', () => {
    const result = validateFeatureCollabTransition(
      'none',
      'branch_open',
      'executing',
      'pending',
    );
    expect(result.valid).toBe(true);
  });

  it('branch_open → merge_queued (feature awaiting merge)', () => {
    const result = validateFeatureCollabTransition(
      'branch_open',
      'merge_queued',
      'awaiting_merge',
      'pending',
    );
    expect(result.valid).toBe(true);
  });

  it('merge_queued → integrating (merge train picks up feature)', () => {
    const result = validateFeatureCollabTransition(
      'merge_queued',
      'integrating',
      'awaiting_merge',
      'pending',
    );
    expect(result.valid).toBe(true);
  });

  it('integrating → merged (merge train completes)', () => {
    const result = validateFeatureCollabTransition(
      'integrating',
      'merged',
      'awaiting_merge',
      'done',
    );
    expect(result.valid).toBe(true);
  });
});

describe('collab-control axis — conflict edges', () => {
  it('branch_open → conflict (conflict detected during execution)', () => {
    const result = validateFeatureCollabTransition(
      'branch_open',
      'conflict',
      'executing',
      'in_progress',
    );
    expect(result.valid).toBe(true);
  });

  it('integrating → conflict (conflict detected during integration)', () => {
    const result = validateFeatureCollabTransition(
      'integrating',
      'conflict',
      'awaiting_merge',
      'in_progress',
    );
    expect(result.valid).toBe(true);
  });

  it('conflict → branch_open (conflict resolved — back to execution)', () => {
    const result = validateFeatureCollabTransition(
      'conflict',
      'branch_open',
      'executing',
      'in_progress',
    );
    expect(result.valid).toBe(true);
  });

  it('conflict → merge_queued (conflict resolved — re-entering merge queue)', () => {
    const result = validateFeatureCollabTransition(
      'conflict',
      'merge_queued',
      'awaiting_merge',
      'pending',
    );
    expect(result.valid).toBe(true);
  });
});

describe('collab-control axis — cancellation edges', () => {
  it.each([
    ['branch_open', 'cancelled', 'executing', 'in_progress'],
    ['merge_queued', 'cancelled', 'awaiting_merge', 'pending'],
    ['conflict', 'cancelled', 'executing', 'in_progress'],
    ['none', 'cancelled', 'discussing', 'pending'],
  ] as const)(
    '%s → cancelled',
    (from, to, workControl, status) => {
      const result = validateFeatureCollabTransition(from, to, workControl, status);
      expect(result.valid).toBe(true);
    },
  );
});

describe('collab-control axis — repair ejection (merge_queued → branch_open)', () => {
  it('merge_queued → branch_open during awaiting_merge (repair ejection)', () => {
    const result = validateFeatureCollabTransition(
      'merge_queued',
      'branch_open',
      'awaiting_merge',
      'pending',
    );
    expect(result.valid).toBe(true);
  });
});

describe('collab-control axis — illegal transitions', () => {
  it.each([
    // merged is terminal — no outbound
    ['merged', 'branch_open', 'work_complete', 'done'],
    ['merged', 'merge_queued', 'work_complete', 'done'],
    ['merged', 'conflict', 'work_complete', 'done'],
    ['merged', 'cancelled', 'work_complete', 'done'],
    // cancelled is terminal — no outbound
    ['cancelled', 'branch_open', 'executing', 'in_progress'],
    ['cancelled', 'merge_queued', 'awaiting_merge', 'pending'],
    // cannot skip states
    ['none', 'merge_queued', 'awaiting_merge', 'pending'],
    ['none', 'integrating', 'awaiting_merge', 'pending'],
    ['none', 'merged', 'work_complete', 'done'],
    ['branch_open', 'integrating', 'awaiting_merge', 'pending'],
    ['branch_open', 'merged', 'work_complete', 'done'],
    ['integrating', 'branch_open', 'awaiting_merge', 'pending'],
    ['integrating', 'merge_queued', 'awaiting_merge', 'pending'],
    // branch can't open without executing phase
    ['none', 'branch_open', 'planning', 'pending'],
  ] as const)(
    'illegal: %s → %s',
    (from, to, workControl, status) => {
      const result = validateFeatureCollabTransition(from, to, workControl, status);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    },
  );

  it('no-op transition is rejected', () => {
    const result = validateFeatureCollabTransition(
      'branch_open',
      'branch_open',
      'executing',
      'in_progress',
    );
    expect(result.valid).toBe(false);
  });
});
