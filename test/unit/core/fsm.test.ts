import {
  type FeatureStateTriple,
  validateFeatureCollabTransition,
  validateFeatureStatusTransition,
  validateFeatureTransition,
  validateFeatureWorkTransition,
  validateTaskCollabTransition,
  validateTaskStatusTransition,
} from '@core/fsm';
import { describe, expect, it } from 'vitest';

import { expectRejected } from '../../helpers/assertions.js';

describe('validateFeatureWorkTransition', () => {
  it.each([
    ['discussing', 'researching', 'done', 'branch_open'],
    ['researching', 'planning', 'done', 'branch_open'],
    ['planning', 'executing', 'done', 'branch_open'],
    ['executing', 'feature_ci', 'done', 'branch_open'],
    ['feature_ci', 'verifying', 'done', 'branch_open'],
    ['verifying', 'awaiting_merge', 'done', 'branch_open'],
    ['awaiting_merge', 'summarizing', 'done', 'merged'],
    ['summarizing', 'work_complete', 'done', 'merged'],
  ] as const)('happy path: %s -> %s (status=%s, collab=%s)', (from, to, status, collab) => {
    expect(validateFeatureWorkTransition(from, to, status, collab)).toEqual({
      valid: true,
    });
  });

  it.each([
    ['executing', 'executing_repair', 'failed', 'branch_open'],
    ['feature_ci', 'executing_repair', 'failed', 'branch_open'],
    ['verifying', 'executing_repair', 'failed', 'branch_open'],
  ] as const)('failure → repair: %s -> %s (status=%s)', (from, to, status, collab) => {
    expect(validateFeatureWorkTransition(from, to, status, collab)).toEqual({
      valid: true,
    });
  });

  it.each([
    ['executing_repair', 'executing', 'done', 'branch_open'],
    ['executing_repair', 'feature_ci', 'done', 'branch_open'],
  ] as const)('repair succeeded → return: %s -> %s (status=%s)', (from, to, status, collab) => {
    expect(validateFeatureWorkTransition(from, to, status, collab)).toEqual({
      valid: true,
    });
  });

  it('repair cannot skip feature_ci and return directly to verifying', () => {
    expect(
      validateFeatureWorkTransition(
        'executing_repair',
        'verifying',
        'done',
        'branch_open',
      ),
    ).toEqual({
      valid: false,
      reason:
        'illegal workControl transition: executing_repair(done) → verifying',
    });
  });

  it('repair failed → replan', () => {
    expect(
      validateFeatureWorkTransition(
        'executing_repair',
        'replanning',
        'failed',
        'branch_open',
      ),
    ).toEqual({ valid: true });
  });

  it('replan succeeded → execute', () => {
    expect(
      validateFeatureWorkTransition(
        'replanning',
        'executing',
        'done',
        'branch_open',
      ),
    ).toEqual({ valid: true });
  });

  it('rejects no-op transition', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'discussing',
        'discussing',
        'pending',
        'none',
      ),
      'no-op',
    );
  });

  it('rejects when cancelled', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'discussing',
        'researching',
        'done',
        'cancelled',
      ),
      'cancelled',
    );
  });

  it('rejects when status is cancelled', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'discussing',
        'researching',
        'cancelled',
        'branch_open',
      ),
      'cancelled',
    );
  });

  it('rejects advancement during conflict', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'discussing',
        'researching',
        'done',
        'conflict',
      ),
      'conflict',
    );
  });

  it('rejects verifying → awaiting_merge without branch_open', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'verifying',
        'awaiting_merge',
        'done',
        'merge_queued',
      ),
      'branch_open',
    );
  });

  it('rejects awaiting_merge → summarizing without merged', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'awaiting_merge',
        'summarizing',
        'done',
        'branch_open',
      ),
      'merged',
    );
  });

  it('rejects advancement when status is not done', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'discussing',
        'researching',
        'pending',
        'branch_open',
      ),
    );
  });

  it('rejects repair from non-repairable phase', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'discussing',
        'executing_repair',
        'failed',
        'branch_open',
      ),
    );
  });

  it('replanning/failed is a dead end', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'replanning',
        'executing',
        'failed',
        'branch_open',
      ),
    );
  });

  it('rejects from terminal work_complete', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'work_complete',
        'discussing',
        'done',
        'merged',
      ),
    );
  });
});

describe('validateFeatureStatusTransition', () => {
  it.each([
    ['pending', 'in_progress', 'discussing', 'branch_open'],
    ['pending', 'cancelled', 'discussing', 'branch_open'],
    ['in_progress', 'done', 'executing', 'branch_open'],
    ['in_progress', 'failed', 'executing', 'branch_open'],
    ['in_progress', 'cancelled', 'executing', 'branch_open'],
  ] as const)('allows %s -> %s', (from, to, work, collab) => {
    expect(validateFeatureStatusTransition(from, to, work, collab)).toEqual({
      valid: true,
    });
  });

  it('rejects no-op', () => {
    expectRejected(
      validateFeatureStatusTransition(
        'pending',
        'pending',
        'discussing',
        'none',
      ),
      'no-op',
    );
  });

  it('rejects non-cancelled when collabControl is cancelled', () => {
    expectRejected(
      validateFeatureStatusTransition(
        'pending',
        'in_progress',
        'discussing',
        'cancelled',
      ),
      'cancelled',
    );
  });

  it('allows cancelled status when collabControl is cancelled', () => {
    expect(
      validateFeatureStatusTransition(
        'pending',
        'cancelled',
        'discussing',
        'cancelled',
      ),
    ).toEqual({ valid: true });
  });

  it('rejects transitions during work_complete', () => {
    expectRejected(
      validateFeatureStatusTransition(
        'done',
        'failed',
        'work_complete',
        'merged',
      ),
      'work_complete',
    );
  });

  it('rejects from terminal done', () => {
    expectRejected(
      validateFeatureStatusTransition(
        'done',
        'pending',
        'executing',
        'branch_open',
      ),
    );
  });
});

describe('validateFeatureCollabTransition', () => {
  it.each([
    ['none', 'branch_open', 'discussing', 'pending'],
    ['none', 'cancelled', 'discussing', 'pending'],
    ['branch_open', 'merge_queued', 'awaiting_merge', 'pending'],
    ['branch_open', 'conflict', 'executing', 'in_progress'],
    ['branch_open', 'cancelled', 'executing', 'in_progress'],
    ['merge_queued', 'integrating', 'awaiting_merge', 'done'],
    ['merge_queued', 'branch_open', 'awaiting_merge', 'done'],
    ['merge_queued', 'cancelled', 'awaiting_merge', 'done'],
    ['integrating', 'merged', 'awaiting_merge', 'done'],
    ['integrating', 'conflict', 'awaiting_merge', 'done'],
    ['integrating', 'cancelled', 'awaiting_merge', 'done'],
    ['conflict', 'branch_open', 'executing', 'in_progress'],
    ['conflict', 'merge_queued', 'awaiting_merge', 'done'],
    ['conflict', 'cancelled', 'executing', 'in_progress'],
  ] as const)('allows %s -> %s (work=%s)', (from, to, work, status) => {
    expect(validateFeatureCollabTransition(from, to, work, status)).toEqual({
      valid: true,
    });
  });

  it('rejects no-op', () => {
    expectRejected(
      validateFeatureCollabTransition('none', 'none', 'discussing', 'pending'),
      'no-op',
    );
  });

  it('rejects branch_open from none when not discussing', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'none',
        'branch_open',
        'executing',
        'in_progress',
      ),
      'discussing',
    );
  });

  it('rejects merge_queued from branch_open without awaiting_merge', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'branch_open',
        'merge_queued',
        'executing',
        'in_progress',
      ),
      'awaiting_merge',
    );
  });

  it('rejects conflict → merge_queued without awaiting_merge', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'conflict',
        'merge_queued',
        'executing',
        'in_progress',
      ),
      'awaiting_merge',
    );
  });

  it('rejects merge_queued → branch_open without awaiting_merge', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'merge_queued',
        'branch_open',
        'executing',
        'in_progress',
      ),
      'awaiting_merge',
    );
  });

  it('rejects from terminal merged', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'merged',
        'branch_open',
        'work_complete',
        'done',
      ),
    );
  });

  it('rejects from terminal cancelled', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'cancelled',
        'branch_open',
        'discussing',
        'pending',
      ),
    );
  });
});

describe('validateFeatureTransition', () => {
  it('validates happy-path phase advancement with status reset', () => {
    const current: FeatureStateTriple = {
      workControl: 'discussing',
      status: 'done',
      collabControl: 'branch_open',
    };
    const proposed: FeatureStateTriple = {
      workControl: 'researching',
      status: 'pending',
      collabControl: 'branch_open',
    };
    expect(validateFeatureTransition(current, proposed)).toEqual({
      valid: true,
    });
  });

  it('validates multi-axis transition (work + status + collab)', () => {
    const current: FeatureStateTriple = {
      workControl: 'verifying',
      status: 'done',
      collabControl: 'branch_open',
    };
    const proposed: FeatureStateTriple = {
      workControl: 'awaiting_merge',
      status: 'pending',
      collabControl: 'merge_queued',
    };
    expect(validateFeatureTransition(current, proposed)).toEqual({
      valid: true,
    });
  });

  it('validates status-only change within phase', () => {
    const current: FeatureStateTriple = {
      workControl: 'executing',
      status: 'pending',
      collabControl: 'branch_open',
    };
    const proposed: FeatureStateTriple = {
      workControl: 'executing',
      status: 'in_progress',
      collabControl: 'branch_open',
    };
    expect(validateFeatureTransition(current, proposed)).toEqual({
      valid: true,
    });
  });

  it('rejects no-op (nothing changed)', () => {
    const state: FeatureStateTriple = {
      workControl: 'discussing',
      status: 'pending',
      collabControl: 'none',
    };
    expectRejected(validateFeatureTransition(state, state), 'no-op');
  });

  it('rejects wrong status after phase advancement', () => {
    const current: FeatureStateTriple = {
      workControl: 'discussing',
      status: 'done',
      collabControl: 'branch_open',
    };
    const proposed: FeatureStateTriple = {
      workControl: 'researching',
      status: 'in_progress',
      collabControl: 'branch_open',
    };
    expectRejected(
      validateFeatureTransition(current, proposed),
      'pending',
      'researching',
    );
  });

  it('requires done status for work_complete advancement', () => {
    const current: FeatureStateTriple = {
      workControl: 'summarizing',
      status: 'done',
      collabControl: 'merged',
    };
    const proposed: FeatureStateTriple = {
      workControl: 'work_complete',
      status: 'done',
      collabControl: 'merged',
    };
    expect(validateFeatureTransition(current, proposed)).toEqual({
      valid: true,
    });
  });
});

describe('validateTaskStatusTransition', () => {
  it.each([
    ['pending', 'ready', 'none'],
    ['pending', 'cancelled', 'none'],
    ['ready', 'running', 'branch_open'],
    ['ready', 'cancelled', 'branch_open'],
    ['running', 'done', 'branch_open'],
    ['running', 'failed', 'branch_open'],
    ['running', 'stuck', 'branch_open'],
    ['running', 'cancelled', 'branch_open'],
    ['stuck', 'running', 'branch_open'],
    ['stuck', 'failed', 'branch_open'],
    ['stuck', 'cancelled', 'branch_open'],
  ] as const)('allows %s -> %s (collab=%s)', (from, to, collab) => {
    expect(validateTaskStatusTransition(from, to, collab)).toEqual({
      valid: true,
    });
  });

  it('rejects no-op', () => {
    expectRejected(
      validateTaskStatusTransition('pending', 'pending', 'none'),
      'no-op',
    );
  });

  it('rejects running while suspended', () => {
    expectRejected(
      validateTaskStatusTransition('stuck', 'running', 'suspended'),
      'suspended',
    );
  });

  it('rejects pending -> running (must go through ready)', () => {
    expectRejected(
      validateTaskStatusTransition('pending', 'running', 'none'),
      'pending',
    );
  });

  it('rejects from terminal done', () => {
    expectRejected(validateTaskStatusTransition('done', 'running', 'merged'));
  });

  it('rejects from terminal cancelled', () => {
    expectRejected(
      validateTaskStatusTransition('cancelled', 'pending', 'none'),
    );
  });
});

describe('validateTaskCollabTransition', () => {
  it.each([
    ['none', 'branch_open', 'ready'],
    ['branch_open', 'merged', 'done'],
    ['branch_open', 'conflict', 'running'],
    ['branch_open', 'suspended', 'running'],
    ['conflict', 'branch_open', 'running'],
    ['suspended', 'branch_open', 'running'],
  ] as const)('allows %s -> %s (status=%s)', (from, to, status) => {
    expect(validateTaskCollabTransition(from, to, status)).toEqual({
      valid: true,
    });
  });

  it('rejects no-op', () => {
    expectRejected(
      validateTaskCollabTransition('none', 'none', 'pending'),
      'no-op',
    );
  });

  it('rejects collab change on cancelled task', () => {
    expectRejected(
      validateTaskCollabTransition('branch_open', 'merged', 'cancelled'),
      'cancelled',
    );
  });

  it('rejects suspend on non-running task', () => {
    expectRejected(
      validateTaskCollabTransition('branch_open', 'suspended', 'ready'),
      'running',
    );
  });

  it('rejects merge on non-done task', () => {
    expectRejected(
      validateTaskCollabTransition('branch_open', 'merged', 'running'),
      'completed',
    );
  });

  it('rejects from terminal merged', () => {
    expectRejected(
      validateTaskCollabTransition('merged', 'branch_open', 'done'),
    );
  });
});
