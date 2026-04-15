# integration harness

Reusable scaffolding for runtime and orchestration integration tests.

This directory owns in-process harnesses, loopback IPC, in-memory doubles, faux-model helpers, and merge-train scenario fixtures used by executable integration tests.
It does not own generic test helpers or PTY-driven TUI coverage.

## Layout

- `in-process-harness.ts` — runs `WorkerRuntime` in-process behind the `SessionHarness` interface.
- `loopback-transport.ts` — buffered in-memory orchestrator/worker transport pair.
- `in-memory-session-store.ts` — Map-backed session persistence double.
- `store-memory.ts` — in-memory `Store` double for agent runs and events.
- `faux-stream.ts` — thin wrapper around pi-ai faux-provider registration plus re-exported response helpers.
- `merge-train-scenario.ts` — isolated graph/merge-train fixture builder around real persistence/core pieces.

## Sharp edges

- Faux provider registration is global to pi-ai. Tests must call `unregister()` in teardown to avoid cross-test bleed.
- Import files directly from this directory; there is no barrel here.
- Use this harness for agent/runtime/orchestrator flows. PTY-driven terminal behavior lives in [TUI integration tests](../tui/README.md).

## See also

- [Testing Strategy](../../../docs/testing.md)
- [runtime](../../../src/runtime/README.md)
- [TUI integration tests](../tui/README.md)
