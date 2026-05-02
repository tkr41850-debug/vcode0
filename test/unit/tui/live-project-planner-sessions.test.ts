import type { GraphSnapshot } from '@core/graph/index';
import { LiveProjectPlannerSessions } from '@tui/live-project-planner-sessions';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function snapshotWith(label: string): GraphSnapshot {
  return {
    milestones: [createMilestoneFixture()],
    features: [createFeatureFixture({ name: label })],
    tasks: [],
  };
}

describe('LiveProjectPlannerSessions', () => {
  it('attach/detach updates attached session id', () => {
    const sessions = new LiveProjectPlannerSessions();
    expect(sessions.getAttachedSessionId()).toBeUndefined();

    sessions.attach('run-project:s-1');
    expect(sessions.getAttachedSessionId()).toBe('run-project:s-1');

    sessions.detach();
    expect(sessions.getAttachedSessionId()).toBeUndefined();
  });

  it('records ops with incrementing opCount keyed on session id', () => {
    const sessions = new LiveProjectPlannerSessions();
    sessions.recordOp('run-project:s-1', snapshotWith('a-1'));
    sessions.recordOp('run-project:s-1', snapshotWith('a-2'));

    const entry = sessions.snapshot('run-project:s-1');
    expect(entry?.opCount).toBe(2);
    expect(entry?.snapshot.features[0]?.name).toBe('a-2');
    expect(entry?.submissionCount).toBe(0);
  });

  it('recordSubmit before any op uses fallback snapshot', () => {
    const sessions = new LiveProjectPlannerSessions();
    sessions.recordSubmit('run-project:s-1', 1, snapshotWith('fallback'));

    const entry = sessions.snapshot('run-project:s-1');
    expect(entry?.opCount).toBe(0);
    expect(entry?.submissionCount).toBe(1);
    expect(entry?.snapshot.features[0]?.name).toBe('fallback');
  });

  it('end clears entry and detaches when matching attached session', () => {
    const sessions = new LiveProjectPlannerSessions();
    sessions.attach('run-project:s-1');
    sessions.recordOp('run-project:s-1', snapshotWith('a-1'));

    sessions.end('run-project:s-1');

    expect(sessions.snapshot('run-project:s-1')).toBeUndefined();
    expect(sessions.getAttachedSessionId()).toBeUndefined();
    expect(sessions.size()).toBe(0);
  });

  it('end on a non-attached session leaves attached session intact', () => {
    const sessions = new LiveProjectPlannerSessions();
    sessions.attach('run-project:s-1');
    sessions.recordOp('run-project:s-2', snapshotWith('b'));

    sessions.end('run-project:s-2');

    expect(sessions.getAttachedSessionId()).toBe('run-project:s-1');
  });
});
