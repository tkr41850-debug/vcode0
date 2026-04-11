# TODO

- Resolve the remaining merge-train authority split between `FeatureGraph.enqueueFeatureMerge(featureId)` and `GitPort.enqueueFeatureMerge(request)`, so queue ownership lives in one place.
- Propagate typed IDs through the runtime and scheduling seams, especially `src/runtime/contracts.ts`, `src/runtime/worker-pool.ts`, and `src/core/scheduling/index.ts`.
- Tighten type-level legality invariants further so dependency endpoints and `AgentRun` scope pairs are impossible to mismatch outside persistence-local row contracts.
