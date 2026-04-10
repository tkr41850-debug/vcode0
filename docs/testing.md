# Testing

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture overview and [specs/README.md](../specs/README.md) for the grouped scenario-spec index.

## Current Test Coverage

Vitest is wired up, and the current executable tests focus on architecture contracts and state derivation rather than full worker/integration flows.

Current targets:

- `test/core/state.test.ts` ↔ `src/core/state/index.ts` — summary availability, derived blocked state, feature aggregate status, and milestone status rules.
- `test/runtime/context.test.ts` ↔ `src/runtime/context/index.ts`, `src/runtime/routing/index.ts`, `src/runtime/ipc/index.ts` — worker-context assembly, routing policy, and typed IPC message contracts.
- `test/persistence/queries.test.ts` ↔ `src/persistence/queries/index.ts` — typed row boundaries and JSON serialization for TEXT-backed support fields.

This is intentionally a seed suite. It validates the current contract surfaces while the broader worker/integration harness is still being scaffolded.

## Planned Integration Harness: pi-sdk Faux Provider

When integration tests are added, use pi-sdk's `fauxModel` with scripted `FauxResponse` sequences as the `streamFn`. That lets tests exercise real agent/tool loops with deterministic responses and no external API calls.

The `test/utils/` modules are placeholder scaffolds today. They intentionally throw `new Error("Not implemented yet.")` until integration-test work begins.

Planned integration targets:

- worker `submit()` / `confirm()` closeout flow
- feature-branch `feature_ci` and agent-level `verifying`
- milestone steering vs autonomous scheduler selection
- reservation-only overlap penalties vs runtime overlap coordination
- same-feature suspend/resume and explicit conflict steering
- cross-feature primary/secondary blocking and later resume
- merge-train integration, ejection, repair, and re-entry
- crash recovery, run wait states, and manual ownership transitions
- warning signals for cost pressure, slow checks, and churn

## Scenario Specs

The canonical markdown scenario inventory lives in [specs/README.md](../specs/README.md).

Keep `specs/test_*.md` focused on end-to-end scenarios that are likely to become integration tests later. Current groups are:

- lifecycle / merge train
- scheduler / graph
- conflict / overlap
- runtime / recovery / waits
- warnings / candidates

## Test Utilities

```text
gvc0/
├── test/
│   ├── core/
│   ├── persistence/
│   ├── runtime/
│   └── utils/
│       ├── faux-stream.ts    -- placeholder faux-provider wrapper scaffold
│       ├── graph-builders.ts -- placeholder graph-fixture scaffold
│       └── store-memory.ts   -- placeholder in-memory store scaffold
```

The `test/utils/` files document the intended harness shape, but they are not wired into executable tests yet.
