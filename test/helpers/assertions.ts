import type { TransitionResult } from '@core/fsm/index';
import type { SchedulableUnit } from '@core/scheduling/index';
import { expect } from 'vitest';

/**
 * Assert that a FSM transition result is invalid and the reason
 * contains each of the given substrings.
 */
export function expectRejected(
  result: TransitionResult,
  ...substrings: string[]
): void {
  expect(result.valid).toBe(false);
  if (!result.valid) {
    for (const s of substrings) {
      expect(result.reason).toContain(s);
    }
  }
}

/** Extract entity IDs from a schedulable-unit list (task id or feature id). */
export function extractSchedulableIds(units: SchedulableUnit[]): string[] {
  return units.map((u) => (u.kind === 'task' ? u.task.id : u.feature.id));
}
