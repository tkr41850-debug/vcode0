import type { GraphSnapshot } from '@core/graph/index';
import type { ProposalOpScopeRef } from '@orchestrator/ports/index';
import { LivePlannerSessions } from '@tui/live-planner-sessions';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

const scopeA: ProposalOpScopeRef = {
  featureId: 'f-1',
  phase: 'plan',
  agentRunId: 'run-feature:f-1:plan',
};

const scopeB: ProposalOpScopeRef = {
  featureId: 'f-2',
  phase: 'replan',
  agentRunId: 'run-feature:f-2:replan',
};

function snapshotWith(label: string): GraphSnapshot {
  return {
    milestones: [createMilestoneFixture()],
    features: [createFeatureFixture({ name: label })],
    tasks: [],
  };
}

describe('LivePlannerSessions', () => {
  it('records ops with incrementing opCount and replaces snapshot', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordOp(scopeA, snapshotWith('a-1'));
    sessions.recordOp(scopeA, snapshotWith('a-2'));

    const entry = sessions.findForFeature('f-1');
    expect(entry).toBeDefined();
    expect(entry?.opCount).toBe(2);
    expect(entry?.snapshot.features[0]?.name).toBe('a-2');
    expect(entry?.submissionCount).toBe(0);
  });

  it('recordSubmit increments submissionCount preserving opCount + snapshot', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordOp(scopeA, snapshotWith('a-1'));
    sessions.recordSubmit(scopeA, 1, snapshotWith('fallback'));

    const entry = sessions.findForFeature('f-1');
    expect(entry?.opCount).toBe(1);
    expect(entry?.submissionCount).toBe(1);
    expect(entry?.snapshot.features[0]?.name).toBe('a-1');
  });

  it('recordSubmit before any op uses fallback snapshot', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordSubmit(scopeA, 1, snapshotWith('fallback'));

    const entry = sessions.findForFeature('f-1');
    expect(entry?.opCount).toBe(0);
    expect(entry?.submissionCount).toBe(1);
    expect(entry?.snapshot.features[0]?.name).toBe('fallback');
  });

  it('end removes the entry; findForFeature returns undefined', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordOp(scopeA, snapshotWith('a-1'));
    expect(sessions.size()).toBe(1);

    sessions.end(scopeA.agentRunId);
    expect(sessions.size()).toBe(0);
    expect(sessions.findForFeature('f-1')).toBeUndefined();
  });

  it('keeps overlapping runs distinct by agentRunId', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordOp(scopeA, snapshotWith('a-1'));
    sessions.recordOp(scopeB, snapshotWith('b-1'));
    sessions.recordOp(scopeB, snapshotWith('b-2'));

    expect(sessions.size()).toBe(2);
    expect(sessions.findForFeature('f-1')?.opCount).toBe(1);
    expect(sessions.findForFeature('f-2')?.opCount).toBe(2);
  });

  it('findForFeature returns undefined for unknown / undefined featureId', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordOp(scopeA, snapshotWith('a'));

    expect(sessions.findForFeature(undefined)).toBeUndefined();
    expect(sessions.findForFeature('f-99')).toBeUndefined();
  });

  it('reusing same agentRunId after end starts fresh op count', () => {
    const sessions = new LivePlannerSessions();
    sessions.recordOp(scopeA, snapshotWith('attempt-1'));
    sessions.recordOp(scopeA, snapshotWith('attempt-1'));
    sessions.end(scopeA.agentRunId);

    sessions.recordOp(scopeA, snapshotWith('attempt-2'));
    const entry = sessions.findForFeature('f-1');
    expect(entry?.opCount).toBe(1);
    expect(entry?.snapshot.features[0]?.name).toBe('attempt-2');
    expect(entry?.submissionCount).toBe(0);
  });
});
