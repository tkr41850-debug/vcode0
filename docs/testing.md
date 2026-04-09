# Testing

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture overview and [specs/README.md](../specs/README.md) for the grouped scenario-spec index.

## Unit Tests

Vitest unit tests cover pure orchestration logic with no LLM calls and no child processes.

Key targets:

- `graph/feature-graph.ts` — DAG mutations, cycle detection, and frontier computation
- `graph/critical-path.ts` — critical-path weight calculation
- `scheduler/retry.ts` — backoff math and jitter bounds
- `scheduler/model-router.ts` — tier selection, ceiling enforcement, and budget pressure
- `ipc/ndjson.ts` — message framing and partial-line handling
- graph invariant rejection (cycles, cross-feature task deps, dangling refs, illegal mutations)
- ordered milestone steering queue vs autonomous scheduler selection
- critical-path-first ordering within a queue bucket
- merge-train queue ordering and state transitions
- work control vs collaboration control type transitions

## Integration Tests: pi-sdk Faux Provider

Integration tests should use pi-sdk's `fauxModel` with scripted `FauxResponse` sequences as the `streamFn`. This runs a real `Agent` loop with real tool dispatch and deterministic responses, without external API calls.

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { fauxStreamFn, fauxModel } from "../test/utils/faux-stream.js";

test("worker calls submit then confirm after passing preflight", async () => {
  const agent = new Agent({
    initialState: { model: fauxModel, tools: workerTools },
    streamFn: fauxStreamFn([
      { toolCalls: [{ name: "submit", args: { summary: "done", filesChanged: [] } }] },
      { toolCalls: [{ name: "confirm", args: { summary: "done", filesChanged: [] } }] },
      { text: "Task complete." },
    ]),
  });
  await agent.prompt("Implement the feature.");
});
```

Integration test targets:

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
│   ├── utils/
│   │   ├── faux-stream.ts    -- fauxModel + fauxStreamFn (wraps pi-sdk faux provider)
│   │   ├── graph-builders.ts -- helpers to build test FeatureGraphs
│   │   └── store-memory.ts   -- in-memory Store (no SQLite needed in tests)
│   ├── unit/
│   └── integration/
```
