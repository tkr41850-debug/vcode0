# Testing

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview and [specs/README.md](../../specs/README.md) for the grouped scenario-spec index.

## Current Test Coverage

Executable tests use two runners:

- **Vitest** — unit coverage under `test/unit/` plus non-TUI integration coverage under `test/integration/`
- **`@microsoft/tui-test`** — PTY-driven terminal E2E coverage under `test/integration/tui/`

`npm run test` only runs Vitest. It does **not** run `test/integration/tui/**`. Run the TUI lane separately with `npm run test:tui:e2e` or `npx tui-test`.

Current integration targets:

- `test/integration/merge-train.test.ts` ↔ `src/core/merge-train/index.ts`, `src/persistence/feature-graph.ts` — merge-queue serialization, dependency legality, ejection/re-entry, conflict repair, and DB rehydration.
- `test/integration/worker-smoke.test.ts` ↔ `src/runtime/worker-pool.ts`, `src/runtime/worker/index.ts`, `src/runtime/ipc/index.ts` — end-to-end runtime plumbing through `LocalWorkerPool`, the in-process harness, and a faux-backed worker run.
- `test/integration/feature-phase-agent-flow.test.ts` ↔ `src/orchestrator/scheduler/index.ts`, `src/orchestrator/scheduler/dispatch.ts`, `src/agents/runtime.ts` — end-to-end feature-phase dispatch, proposal approval flow, verify/summarize/replan paths, and shared session persistence for feature phases.
- `test/integration/tui/smoke.test.ts` ↔ `src/main.ts`, `src/tui/app.ts` — PTY-driven terminal E2E coverage via `@microsoft/tui-test`, kept separate from Vitest, for startup, overlays, draft approval flow, and quit behavior.

Current unit targets include:

- `test/unit/core/` — FSM legality, graph mutations, scheduling, merge-train ordering, warnings, and derived state.
- `test/unit/runtime/` — worker-context assembly, routing policy, session persistence, IPC framing, and worker-pool/runtime contracts.
- `test/unit/persistence/` — row serialization, codecs, migrations, sqlite store behavior, and `PersistentFeatureGraph` persistence semantics.

The suite is still foundation-first, but integration coverage now exists for the merge-train path, the worker runtime bootstrap, feature-phase agent flow, and a dedicated terminal-E2E lane for the interactive pi-tui shell.

## Integration Harness: pi-sdk Faux Provider

Integration tests use pi-ai's `registerFauxProvider()` to register a deterministic provider in the global API registry, then script assistant turns with `fauxAssistantMessage()`, `fauxText()`, `fauxThinking()`, and `fauxToolCall()`. That lets tests exercise real agent/tool loops with deterministic responses and no external API calls.

For worker-runtime tests, register the faux provider on a real API/model slot that `resolveModel()` can return. The current smoke test binds faux to `anthropic-messages` / `claude-sonnet-4-20250514` rather than relying on a synthetic `faux:faux-1` model id.

Because faux-provider registration is global, tests must call `unregister()` in teardown to avoid cross-test bleed.

The executable harness lives under `test/integration/harness/`. Shared deterministic fixture builders live under `test/helpers/`.

Current integration targets:

- merge-train integration, ejection, repair, and re-entry
- worker runtime bootstrap through the in-process harness
- feature-phase dispatch, proposal approval, and replan/summarize flow through the scheduler and feature-agent runtime
- interactive TUI startup, help modal, monitor overlay, draft approval state, and quit flow through `@microsoft/tui-test`
- merge-train verification execution on rebased feature branches (`test/integration/integration-coordinator-cas.test.ts` plus the unit-level coordinator coverage in `test/unit/orchestrator/integration-coordinator.test.ts`)

Deferred integration targets:

- worker `submit()` / `confirm()` closeout flow
- feature-branch shell execution in `ci_check`
- milestone steering vs autonomous scheduler selection
- reservation-only overlap penalties vs runtime overlap coordination
- same-feature suspend/resume and explicit conflict steering
- cross-feature primary/secondary blocking and later resume
- crash recovery, run wait states, and manual ownership transitions
- warning signals for cost pressure, slow checks, and churn

## Scenario Specs

The canonical markdown scenario inventory lives in [specs/README.md](../../specs/README.md).

Keep `specs/test_*.md` focused on end-to-end scenarios that are likely to become integration tests later. Current groups are:

- lifecycle / merge train
- scheduler / graph
- conflict / overlap
- runtime / recovery / waits
- warnings / candidates

## Assertion style

Use inline `assert(...)` from `node:assert/strict` when test code needs type narrowing before later assertions or setup steps.

Prefer:

```ts
assert(task !== undefined, 'missing task fixture');
assert(
  directive?.kind === 'conflict_steer',
  'expected conflict_steer directive',
);
```

Avoid splitting same invariant across matcher plus manual branch:

```ts
expect(directive?.kind).toBe('conflict_steer');
if (directive?.kind !== 'conflict_steer') {
  throw new Error('expected conflict_steer directive');
}
```

Rule:

- use `assert(...)` for local preconditions and type narrowing
- use `expect(...)` for behavioral checks, rich diffs, and payload matching after value is narrowed
- include explicit failure messages on asserts so fixture/setup failures stay readable

## Test Utilities

```text
gvc0/
├── test/
│   ├── helpers/
│   │   └── graph-builders.ts         -- shared deterministic graph/feature/task fixtures
│   ├── integration/
│   │   ├── feature-phase-agent-flow.test.ts -- feature-phase dispatch and approval integration coverage
│   │   ├── merge-train.test.ts       -- persistent merge-train integration coverage
│   │   ├── worker-smoke.test.ts      -- faux-backed in-process worker runtime smoke test
│   │   └── harness/
│   │       ├── faux-stream.ts        -- thin pi-ai faux-provider wrapper + helper re-exports
│   │       ├── in-memory-session-store.ts -- SessionStore test double
│   │       ├── in-process-harness.ts -- SessionHarness running WorkerRuntime in-process
│   │       ├── loopback-transport.ts -- paired in-memory IPC transport
│   │       ├── merge-train-scenario.ts -- persistent graph merge-train fixture builder
│   │       └── store-memory.ts       -- in-memory Store implementation for integration tests
│   └── unit/
│       ├── core/
│       ├── persistence/
│       └── runtime/
```

`test/integration/harness/` now contains executable scaffolding used by the current integration tests rather than placeholder stubs.

## Terminal E2E lane

Run PTY-driven TUI coverage with:

```bash
npm run test:tui:e2e
```

Or directly with:

```bash
npx tui-test
```

Lane split:

- `npm run test` / `vitest run` — Vitest only; excludes `test/integration/tui/**`
- `npm run test:tui:e2e` / `npx tui-test` — `@microsoft/tui-test` only; runs `test/integration/tui/**`

This lane is separate from Vitest. It uses `@microsoft/tui-test` to launch the real `src/main.ts` entrypoint inside a pseudo-terminal, then sends keypresses and asserts visible terminal text. Keep it focused on user-visible shell behavior; pure rendering and state-mapping assertions should stay in Vitest unit tests. CLI/bootstrap checks like `parseAppMode()` and startup error handling stay in Vitest, while live keyboard flows like help, monitor, and quit belong in the TUI lane.
