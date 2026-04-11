import {
  FEATURE_COLLAB_SUCCESS_SUCCESSOR,
  FEATURE_WORK_SUCCESS_SUCCESSOR,
  TASK_COLLAB_SUCCESS_SUCCESSOR,
  TASK_STATUS_SUCCESS_SUCCESSOR,
  validateFeatureCollabTransition,
  validateFeatureWorkTransition,
  validateTaskCollabTransition,
  validateTaskStatusTransition,
} from '@core/fsm';
import { describe, expect, it } from 'vitest';

import { expectRejected } from '../../helpers/assertions.js';

describe('validateFeatureWorkTransition', () => {
  it.each([
    ['discussing', 'researching', 'none'],
    ['discussing', 'planning', 'none'],
    ['planning', 'executing', 'branch_open'],
    ['executing', 'feature_ci', 'branch_open'],
    ['feature_ci', 'executing_repair', 'branch_open'],
    ['awaiting_merge', 'summarizing', 'merged'],
    ['awaiting_merge', 'work_complete', 'merged'],
    ['executing_repair', 'feature_ci', 'branch_open'],
    ['replanning', 'planning', 'branch_open'],
  ] as const)('allows %s -> %s (guard: %s)', (from, to, guard) => {
    expect(validateFeatureWorkTransition(from, to, guard)).toEqual({
      valid: true,
    });
  });

  it('rejects executing -> feature_ci when collabControl is cancelled', () => {
    expectRejected(
      validateFeatureWorkTransition('executing', 'feature_ci', 'cancelled'),
      'cancelled',
    );
  });

  it('rejects awaiting_merge -> summarizing when collabControl is not merged', () => {
    expectRejected(
      validateFeatureWorkTransition(
        'awaiting_merge',
        'summarizing',
        'branch_open',
      ),
      'merged',
    );
  });

  it('rejects transitions from terminal state work_complete', () => {
    expectRejected(
      validateFeatureWorkTransition('work_complete', 'discussing', 'merged'),
      'work_complete',
    );
  });

  it('rejects invalid transition discussing -> executing', () => {
    expectRejected(
      validateFeatureWorkTransition('discussing', 'executing', 'none'),
      'discussing',
      'executing',
    );
  });
});

describe('validateFeatureCollabTransition', () => {
  it.each([
    ['none', 'branch_open', 'discussing'],
    ['branch_open', 'merge_queued', 'awaiting_merge'],
    ['merge_queued', 'integrating', 'awaiting_merge'],
    ['integrating', 'merged', 'awaiting_merge'],
    ['conflict', 'branch_open', 'executing'],
    ['branch_open', 'cancelled', 'discussing'],
  ] as const)('allows %s -> %s (guard: %s)', (from, to, guard) => {
    expect(validateFeatureCollabTransition(from, to, guard)).toEqual({
      valid: true,
    });
  });

  it('rejects branch_open -> merge_queued when workControl is not awaiting_merge', () => {
    expectRejected(
      validateFeatureCollabTransition(
        'branch_open',
        'merge_queued',
        'executing',
      ),
      'awaiting_merge',
    );
  });

  it('rejects transitions from terminal state merged', () => {
    expectRejected(
      validateFeatureCollabTransition('merged', 'branch_open', 'work_complete'),
      'merged',
    );
  });

  it('rejects transitions from terminal state cancelled', () => {
    expectRejected(
      validateFeatureCollabTransition('cancelled', 'branch_open', 'discussing'),
      'cancelled',
    );
  });
});

describe('validateTaskStatusTransition', () => {
  it.each([
    ['pending', 'ready', 'none'],
    ['ready', 'running', 'branch_open'],
    ['running', 'done', 'branch_open'],
    ['running', 'stuck', 'branch_open'],
    ['running', 'failed', 'branch_open'],
    ['stuck', 'running', 'branch_open'],
    ['pending', 'cancelled', 'none'],
  ] as const)('allows %s -> %s (guard: %s)', (from, to, guard) => {
    expect(validateTaskStatusTransition(from, to, guard)).toEqual({
      valid: true,
    });
  });

  it('rejects transitions from terminal state done', () => {
    expectRejected(
      validateTaskStatusTransition('done', 'running', 'merged'),
      'done',
    );
  });

  it('rejects transitions from terminal state cancelled', () => {
    expectRejected(
      validateTaskStatusTransition('cancelled', 'pending', 'none'),
      'cancelled',
    );
  });

  it('rejects pending -> running (must go through ready)', () => {
    expectRejected(
      validateTaskStatusTransition('pending', 'running', 'none'),
      'pending',
      'running',
    );
  });
});

describe('validateTaskCollabTransition', () => {
  it.each([
    ['none', 'branch_open', 'ready'],
    ['branch_open', 'suspended', 'running'],
    ['branch_open', 'merged', 'done'],
    ['suspended', 'branch_open', 'running'],
    ['conflict', 'branch_open', 'running'],
  ] as const)('allows %s -> %s (guard: %s)', (from, to, guard) => {
    expect(validateTaskCollabTransition(from, to, guard)).toEqual({
      valid: true,
    });
  });

  it('rejects branch_open -> merged when taskStatus is not done', () => {
    expectRejected(
      validateTaskCollabTransition('branch_open', 'merged', 'running'),
      'done',
    );
  });

  it('rejects transitions from terminal state merged', () => {
    expectRejected(
      validateTaskCollabTransition('merged', 'branch_open', 'done'),
      'merged',
    );
  });
});

describe('success-successor maps', () => {
  it('FEATURE_WORK_SUCCESS_SUCCESSOR has correct terminal behavior', () => {
    expect(FEATURE_WORK_SUCCESS_SUCCESSOR.get('discussing')).toBe(
      'researching',
    );
    expect(FEATURE_WORK_SUCCESS_SUCCESSOR.has('work_complete')).toBe(false);
  });

  it('FEATURE_COLLAB_SUCCESS_SUCCESSOR has correct terminal behavior', () => {
    expect(FEATURE_COLLAB_SUCCESS_SUCCESSOR.get('none')).toBe('branch_open');
    expect(FEATURE_COLLAB_SUCCESS_SUCCESSOR.has('merged')).toBe(false);
    expect(FEATURE_COLLAB_SUCCESS_SUCCESSOR.has('cancelled')).toBe(false);
  });

  it('TASK_STATUS_SUCCESS_SUCCESSOR omits running (use completeTask)', () => {
    expect(TASK_STATUS_SUCCESS_SUCCESSOR.get('pending')).toBe('ready');
    expect(TASK_STATUS_SUCCESS_SUCCESSOR.has('running')).toBe(false);
  });

  it('TASK_COLLAB_SUCCESS_SUCCESSOR omits branch_open (merged via completeTask)', () => {
    expect(TASK_COLLAB_SUCCESS_SUCCESSOR.get('none')).toBe('branch_open');
    expect(TASK_COLLAB_SUCCESS_SUCCESSOR.get('suspended')).toBe('branch_open');
    expect(TASK_COLLAB_SUCCESS_SUCCESSOR.has('branch_open')).toBe(false);
  });
});
