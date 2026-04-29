import type { EventRecord } from '@core/types/index';
import type { EventQuery, OrchestratorPorts } from '@orchestrator/ports/index';
import { countVerifyFailuresSinceLastReplan } from '@orchestrator/scheduler/warnings';
import { describe, expect, it } from 'vitest';

function mockStore(events: EventRecord[]): OrchestratorPorts['store'] {
  return {
    listEvents: (_query?: EventQuery) => events,
  } as unknown as OrchestratorPorts['store'];
}

function verifyEvent(featureId: string, ok: boolean, t: number): EventRecord {
  return {
    eventType: 'feature_phase_completed',
    entityId: featureId,
    timestamp: t,
    payload: { phase: 'verify', summary: '', extra: { ok } },
  };
}

function planEvent(
  featureId: string,
  phase: 'plan' | 'replan',
  ok: boolean,
  t: number,
): EventRecord {
  return {
    eventType: 'feature_phase_completed',
    entityId: featureId,
    timestamp: t,
    payload: { phase, summary: '', extra: { ok } },
  };
}

describe('countVerifyFailuresSinceLastReplan', () => {
  it('no events → 0', () => {
    const store = mockStore([]);
    const count = countVerifyFailuresSinceLastReplan(store, 'f-test-1');
    expect(count).toBe(0);
  });

  it('only failed verifies → counts all', () => {
    const events = [
      verifyEvent('f-test-1', false, 100),
      verifyEvent('f-test-1', false, 200),
      verifyEvent('f-test-1', false, 300),
    ];
    const store = mockStore(events);
    const count = countVerifyFailuresSinceLastReplan(store, 'f-test-1');
    expect(count).toBe(3);
  });

  it('successful replan resets count', () => {
    const events = [
      verifyEvent('f-test-1', false, 100),
      verifyEvent('f-test-1', false, 200),
      planEvent('f-test-1', 'replan', true, 300),
      verifyEvent('f-test-1', false, 400),
    ];
    const store = mockStore(events);
    const count = countVerifyFailuresSinceLastReplan(store, 'f-test-1');
    expect(count).toBe(1);
  });

  it('failed replan does NOT reset', () => {
    const events = [
      verifyEvent('f-test-1', false, 100),
      verifyEvent('f-test-1', false, 200),
      planEvent('f-test-1', 'replan', false, 300),
      verifyEvent('f-test-1', false, 400),
    ];
    const store = mockStore(events);
    const count = countVerifyFailuresSinceLastReplan(store, 'f-test-1');
    expect(count).toBe(3);
  });

  it('successful verify is NOT counted', () => {
    const events = [
      verifyEvent('f-test-1', true, 100),
      verifyEvent('f-test-1', true, 200),
    ];
    const store = mockStore(events);
    const count = countVerifyFailuresSinceLastReplan(store, 'f-test-1');
    expect(count).toBe(0);
  });
});
