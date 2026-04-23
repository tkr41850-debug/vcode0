import { findLatestPlanEvent } from '@agents/runtime';
import type { EventRecord } from '@core/types/index';
import { describe, expect, it } from 'vitest';

function planCompleted(
  tag: string,
  phase: 'plan' | 'replan',
  timestamp: number,
): EventRecord {
  return {
    eventType: 'feature_phase_completed',
    entityId: 'f-1',
    timestamp,
    payload: { phase, summary: tag, extra: { summary: tag } },
  };
}

function decision(
  eventType: 'proposal_applied' | 'proposal_rejected' | 'proposal_apply_failed',
  phase: 'plan' | 'replan',
  timestamp: number,
): EventRecord {
  return {
    eventType,
    entityId: 'f-1',
    timestamp,
    payload: { phase },
  };
}

function tag(event: EventRecord | undefined): string | undefined {
  const summary = event?.payload?.summary;
  return typeof summary === 'string' ? summary : undefined;
}

describe('findLatestPlanEvent', () => {
  it('returns undefined when no events', () => {
    expect(findLatestPlanEvent([])).toBeUndefined();
  });

  it('returns undefined when plan has no acceptance yet', () => {
    const events = [planCompleted('p1', 'plan', 1)];
    expect(findLatestPlanEvent(events)).toBeUndefined();
  });

  it('returns accepted plan completion event', () => {
    const events = [
      planCompleted('p1', 'plan', 1),
      decision('proposal_applied', 'plan', 2),
    ];
    expect(tag(findLatestPlanEvent(events))).toBe('p1');
  });

  it('skips rejected plan', () => {
    const events = [
      planCompleted('p1', 'plan', 1),
      decision('proposal_rejected', 'plan', 2),
    ];
    expect(findLatestPlanEvent(events)).toBeUndefined();
  });

  it('skips apply-failed plan', () => {
    const events = [
      planCompleted('p1', 'plan', 1),
      decision('proposal_apply_failed', 'plan', 2),
    ];
    expect(findLatestPlanEvent(events)).toBeUndefined();
  });

  it('returns newer accepted replan after earlier rejected plan', () => {
    const events = [
      planCompleted('p1', 'plan', 1),
      decision('proposal_rejected', 'plan', 2),
      planCompleted('p2', 'replan', 3),
      decision('proposal_applied', 'replan', 4),
    ];
    expect(tag(findLatestPlanEvent(events))).toBe('p2');
  });

  it('keeps prior accepted plan when newer replan is rejected', () => {
    const events = [
      planCompleted('p1', 'plan', 1),
      decision('proposal_applied', 'plan', 2),
      planCompleted('p2', 'replan', 3),
      decision('proposal_rejected', 'replan', 4),
    ];
    expect(tag(findLatestPlanEvent(events))).toBe('p1');
  });
});
