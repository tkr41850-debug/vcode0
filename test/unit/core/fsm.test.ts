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

describe('validateFeatureWorkTransition', () => {
  it('allows discussing -> researching', () => {
    expect(
      validateFeatureWorkTransition('discussing', 'researching', 'none'),
    ).toEqual({ valid: true });
  });

  it('allows discussing -> planning (budget skip)', () => {
    expect(
      validateFeatureWorkTransition('discussing', 'planning', 'none'),
    ).toEqual({ valid: true });
  });

  it('allows planning -> executing', () => {
    expect(
      validateFeatureWorkTransition('planning', 'executing', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows executing -> feature_ci when collabControl is not cancelled', () => {
    expect(
      validateFeatureWorkTransition('executing', 'feature_ci', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows feature_ci -> executing_repair', () => {
    expect(
      validateFeatureWorkTransition(
        'feature_ci',
        'executing_repair',
        'branch_open',
      ),
    ).toEqual({ valid: true });
  });

  it('allows awaiting_merge -> summarizing when collabControl is merged', () => {
    expect(
      validateFeatureWorkTransition('awaiting_merge', 'summarizing', 'merged'),
    ).toEqual({ valid: true });
  });

  it('allows awaiting_merge -> work_complete when collabControl is merged (budget)', () => {
    expect(
      validateFeatureWorkTransition(
        'awaiting_merge',
        'work_complete',
        'merged',
      ),
    ).toEqual({ valid: true });
  });

  it('allows executing_repair -> feature_ci', () => {
    expect(
      validateFeatureWorkTransition(
        'executing_repair',
        'feature_ci',
        'branch_open',
      ),
    ).toEqual({ valid: true });
  });

  it('allows replanning -> planning', () => {
    expect(
      validateFeatureWorkTransition('replanning', 'planning', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('rejects executing -> feature_ci when collabControl is cancelled', () => {
    const result = validateFeatureWorkTransition(
      'executing',
      'feature_ci',
      'cancelled',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('cancelled');
    }
  });

  it('rejects awaiting_merge -> summarizing when collabControl is not merged', () => {
    const result = validateFeatureWorkTransition(
      'awaiting_merge',
      'summarizing',
      'branch_open',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('merged');
    }
  });

  it('rejects transitions from terminal state work_complete', () => {
    const result = validateFeatureWorkTransition(
      'work_complete',
      'discussing',
      'merged',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('work_complete');
    }
  });

  it('rejects invalid transition discussing -> executing', () => {
    const result = validateFeatureWorkTransition(
      'discussing',
      'executing',
      'none',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('discussing');
      expect(result.reason).toContain('executing');
    }
  });
});

describe('validateFeatureCollabTransition', () => {
  it('allows none -> branch_open', () => {
    expect(
      validateFeatureCollabTransition('none', 'branch_open', 'discussing'),
    ).toEqual({ valid: true });
  });

  it('allows branch_open -> merge_queued when workControl is awaiting_merge', () => {
    expect(
      validateFeatureCollabTransition(
        'branch_open',
        'merge_queued',
        'awaiting_merge',
      ),
    ).toEqual({ valid: true });
  });

  it('allows merge_queued -> integrating', () => {
    expect(
      validateFeatureCollabTransition(
        'merge_queued',
        'integrating',
        'awaiting_merge',
      ),
    ).toEqual({ valid: true });
  });

  it('allows integrating -> merged', () => {
    expect(
      validateFeatureCollabTransition(
        'integrating',
        'merged',
        'awaiting_merge',
      ),
    ).toEqual({ valid: true });
  });

  it('allows conflict -> branch_open', () => {
    expect(
      validateFeatureCollabTransition('conflict', 'branch_open', 'executing'),
    ).toEqual({ valid: true });
  });

  it('allows branch_open -> cancelled', () => {
    expect(
      validateFeatureCollabTransition('branch_open', 'cancelled', 'discussing'),
    ).toEqual({ valid: true });
  });

  it('rejects branch_open -> merge_queued when workControl is not awaiting_merge', () => {
    const result = validateFeatureCollabTransition(
      'branch_open',
      'merge_queued',
      'executing',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('awaiting_merge');
    }
  });

  it('rejects transitions from terminal state merged', () => {
    const result = validateFeatureCollabTransition(
      'merged',
      'branch_open',
      'work_complete',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('merged');
    }
  });

  it('rejects transitions from terminal state cancelled', () => {
    const result = validateFeatureCollabTransition(
      'cancelled',
      'branch_open',
      'discussing',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('cancelled');
    }
  });
});

describe('validateTaskStatusTransition', () => {
  it('allows pending -> ready', () => {
    expect(validateTaskStatusTransition('pending', 'ready', 'none')).toEqual({
      valid: true,
    });
  });

  it('allows ready -> running', () => {
    expect(
      validateTaskStatusTransition('ready', 'running', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows running -> done', () => {
    expect(
      validateTaskStatusTransition('running', 'done', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows running -> stuck', () => {
    expect(
      validateTaskStatusTransition('running', 'stuck', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows running -> failed', () => {
    expect(
      validateTaskStatusTransition('running', 'failed', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows stuck -> running', () => {
    expect(
      validateTaskStatusTransition('stuck', 'running', 'branch_open'),
    ).toEqual({ valid: true });
  });

  it('allows pending -> cancelled', () => {
    expect(
      validateTaskStatusTransition('pending', 'cancelled', 'none'),
    ).toEqual({ valid: true });
  });

  it('rejects transitions from terminal state done', () => {
    const result = validateTaskStatusTransition('done', 'running', 'merged');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('done');
    }
  });

  it('rejects transitions from terminal state cancelled', () => {
    const result = validateTaskStatusTransition('cancelled', 'pending', 'none');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('cancelled');
    }
  });

  it('rejects pending -> running (must go through ready)', () => {
    const result = validateTaskStatusTransition('pending', 'running', 'none');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('pending');
      expect(result.reason).toContain('running');
    }
  });
});

describe('validateTaskCollabTransition', () => {
  it('allows none -> branch_open', () => {
    expect(
      validateTaskCollabTransition('none', 'branch_open', 'ready'),
    ).toEqual({ valid: true });
  });

  it('allows branch_open -> suspended', () => {
    expect(
      validateTaskCollabTransition('branch_open', 'suspended', 'running'),
    ).toEqual({ valid: true });
  });

  it('allows branch_open -> merged when taskStatus is done', () => {
    expect(
      validateTaskCollabTransition('branch_open', 'merged', 'done'),
    ).toEqual({ valid: true });
  });

  it('allows suspended -> branch_open (resume)', () => {
    expect(
      validateTaskCollabTransition('suspended', 'branch_open', 'running'),
    ).toEqual({ valid: true });
  });

  it('allows conflict -> branch_open', () => {
    expect(
      validateTaskCollabTransition('conflict', 'branch_open', 'running'),
    ).toEqual({ valid: true });
  });

  it('rejects branch_open -> merged when taskStatus is not done', () => {
    const result = validateTaskCollabTransition(
      'branch_open',
      'merged',
      'running',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('done');
    }
  });

  it('rejects transitions from terminal state merged', () => {
    const result = validateTaskCollabTransition(
      'merged',
      'branch_open',
      'done',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('merged');
    }
  });
});

describe('success-successor maps', () => {
  it('maps feature work discussing -> researching', () => {
    expect(FEATURE_WORK_SUCCESS_SUCCESSOR.get('discussing')).toBe(
      'researching',
    );
  });

  it('maps feature work executing -> feature_ci', () => {
    expect(FEATURE_WORK_SUCCESS_SUCCESSOR.get('executing')).toBe('feature_ci');
  });

  it('maps feature work replanning -> planning', () => {
    expect(FEATURE_WORK_SUCCESS_SUCCESSOR.get('replanning')).toBe('planning');
  });

  it('has no entry for terminal work_complete', () => {
    expect(FEATURE_WORK_SUCCESS_SUCCESSOR.has('work_complete')).toBe(false);
  });

  it('maps feature collab none -> branch_open', () => {
    expect(FEATURE_COLLAB_SUCCESS_SUCCESSOR.get('none')).toBe('branch_open');
  });

  it('has no entry for terminal merged', () => {
    expect(FEATURE_COLLAB_SUCCESS_SUCCESSOR.has('merged')).toBe(false);
  });

  it('maps task status pending -> ready', () => {
    expect(TASK_STATUS_SUCCESS_SUCCESSOR.get('pending')).toBe('ready');
  });

  it('has no entry for running (use completeTask)', () => {
    expect(TASK_STATUS_SUCCESS_SUCCESSOR.has('running')).toBe(false);
  });

  it('maps task collab none -> branch_open', () => {
    expect(TASK_COLLAB_SUCCESS_SUCCESSOR.get('none')).toBe('branch_open');
  });

  it('has no entry for branch_open (merged via completeTask)', () => {
    expect(TASK_COLLAB_SUCCESS_SUCCESSOR.has('branch_open')).toBe(false);
  });

  it('maps task collab suspended -> branch_open', () => {
    expect(TASK_COLLAB_SUCCESS_SUCCESSOR.get('suspended')).toBe('branch_open');
  });
});
