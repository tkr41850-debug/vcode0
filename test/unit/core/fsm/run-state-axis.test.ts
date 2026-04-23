import { type RunState, validateRunStateTransition } from '@core/fsm/index';
import { describe, expect, it } from 'vitest';

// ── Run-state axis: legal transitions ───────────────────────────────────
//
// From docs/architecture/data-model.md and specs/test_agent_run_wait_states.md:
//
//   ready → running | cancelled
//   running → retry_await | await_response | await_approval
//           | completed | failed | cancelled
//   retry_await → ready | running | cancelled
//   await_response → ready | running | cancelled
//   await_approval → ready | running | cancelled
//
//   Terminals: completed, failed, cancelled — no outbound transitions.
//
// Note: `manual` is NOT an AgentRunStatus value — manual ownership lives on
// RunOwner. Do not test `manual` as a run-state.

describe('run-state axis — legal transitions (happy path)', () => {
  it.each([
    ['ready', 'running'],
    ['running', 'completed'],
    ['running', 'failed'],
    ['running', 'cancelled'],
    ['running', 'retry_await'],
    ['retry_await', 'ready'],
    ['retry_await', 'running'],
  ] as const satisfies readonly (readonly [
    RunState,
    RunState,
  ])[])('%s → %s is legal', (from, to) => {
    const result = validateRunStateTransition(from, to);
    expect(result.valid).toBe(true);
  });
});

describe('run-state axis — help / approval overlays', () => {
  it.each([
    ['running', 'await_response'],
    ['running', 'await_approval'],
  ] as const satisfies readonly (readonly [
    RunState,
    RunState,
  ])[])('%s → %s is legal (wait overlay)', (from, to) => {
    const result = validateRunStateTransition(from, to);
    expect(result.valid).toBe(true);
  });

  it.each([
    ['await_response', 'ready'],
    ['await_response', 'running'],
    ['await_response', 'cancelled'],
    ['await_approval', 'ready'],
    ['await_approval', 'running'],
    ['await_approval', 'cancelled'],
  ] as const satisfies readonly (readonly [
    RunState,
    RunState,
  ])[])('%s → %s is legal (wait overlay exit)', (from, to) => {
    const result = validateRunStateTransition(from, to);
    expect(result.valid).toBe(true);
  });
});

describe('run-state axis — cancellation edges', () => {
  it.each([
    ['ready', 'cancelled'],
    ['running', 'cancelled'],
    ['retry_await', 'cancelled'],
    ['await_response', 'cancelled'],
    ['await_approval', 'cancelled'],
  ] as const satisfies readonly (readonly [
    RunState,
    RunState,
  ])[])('%s → cancelled is legal', (from, to) => {
    const result = validateRunStateTransition(from, to);
    expect(result.valid).toBe(true);
  });
});

describe('run-state axis — illegal transitions', () => {
  it.each([
    // Terminal outbound transitions are illegal
    ['completed', 'running'],
    ['completed', 'ready'],
    ['completed', 'cancelled'],
    ['failed', 'ready'],
    ['failed', 'running'],
    ['failed', 'cancelled'],
    ['cancelled', 'ready'],
    ['cancelled', 'running'],
    // Cannot jump straight from ready to a wait overlay without running first
    ['ready', 'await_response'],
    ['ready', 'await_approval'],
    ['ready', 'retry_await'],
    ['ready', 'completed'],
    ['ready', 'failed'],
    // Cannot jump between wait overlays without returning to running
    ['await_response', 'await_approval'],
    ['await_approval', 'await_response'],
    ['await_response', 'retry_await'],
    ['await_approval', 'retry_await'],
    // retry_await cannot skip directly to wait overlays or terminals
    ['retry_await', 'await_response'],
    ['retry_await', 'await_approval'],
    ['retry_await', 'completed'],
    ['retry_await', 'failed'],
  ] as const satisfies readonly (readonly [
    RunState,
    RunState,
  ])[])('illegal: %s → %s', (from, to) => {
    const result = validateRunStateTransition(from, to);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('no-op transition is rejected (ready → ready)', () => {
    const result = validateRunStateTransition('ready', 'ready');
    expect(result.valid).toBe(false);
  });

  it('no-op transition is rejected (running → running)', () => {
    const result = validateRunStateTransition('running', 'running');
    expect(result.valid).toBe(false);
  });
});
