# gsd2 Testing

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Testing

### Unit Tests

Vitest unit tests for pure logic — no LLM calls, no child processes.

Key targets:
- `graph/feature-graph.ts` — DAG mutations, cycle detection, frontier computation
- `graph/critical-path.ts` — critical path weight calculation
- `scheduler/retry.ts` — backoff math, jitter bounds
- `scheduler/model-router.ts` — tier selection, ceiling enforcement, budget pressure
- `ipc/ndjson.ts` — message framing, partial line handling

### Integration Tests: pi-sdk Faux Provider

Integration tests use pi-sdk's `fauxModel` + scripted `FauxResponse` sequences as the `streamFn`. This runs a real `Agent` loop with real tool dispatch — no API calls, deterministic responses.

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { fauxStreamFn, fauxModel } from "../test/utils/faux-stream.js";

test("worker calls submit after passing verification", async () => {
  const agent = new Agent({
    initialState: { model: fauxModel, tools: workerTools },
    streamFn: fauxStreamFn([
      { toolCalls: [{ name: "submit", args: { summary: "done", filesChanged: [] } }] },
      { text: "Task complete." },
    ]),
  });
  await agent.prompt("Implement the feature.");
});
```

Integration test targets:
- Worker submit → verification pass/fail loop
- Worker suspend/resume IPC flow
- Planner builds valid DAG via tool calls
- Scheduler dispatches correct frontier after task completion
- Crash recovery: orphaned `running` tasks reset or resumed on startup

### Test Utilities

```
gsd2/
├── test/
│   ├── utils/
│   │   ├── faux-stream.ts    -- fauxModel + fauxStreamFn (wraps pi-sdk faux provider)
│   │   ├── graph-builders.ts -- helpers to build test FeatureGraphs
│   │   └── store-memory.ts   -- in-memory Store (no SQLite needed in tests)
│   ├── unit/
│   └── integration/
```
