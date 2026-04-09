# Feature Summary Status

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Purpose

This document defines how post-merge feature summarization is recorded, including the budget-mode case where the summary phase is intentionally skipped.

## Baseline Storage

Feature summaries are stored directly on the feature as nullable text:

```ts
interface Feature {
  // ...
  summary?: string;
}
```

## Derived Availability

Summary availability is derived from `workControl` plus presence/absence of summary text:

- `workControl = "summarizing"` and no summary text yet → waiting for summary
- `workControl = "work_complete"` and no summary text → summary skipped
- summary text exists → summary available

## Baseline Rule

After collaboration control reaches `merged`:
- normal flow enters `summarizing`, writes summary text, then moves to `work_complete`
- budget-mode flow may skip the summarization phase and move directly to `work_complete` without writing summary text

This keeps one consistent completion rule: merged features still reach `work_complete`, while summary availability is derived from the lifecycle plus whether summary text exists.

## Why This Exists

`work_complete` should mean the feature is done from the orchestrator's perspective. Deriving summary availability from lifecycle + summary presence avoids duplicating the same fact in a separate summary-status enum.

## Related

- [Data Model](./data-model.md)
- [Budget and Model Routing](./budget-and-model-routing.md)
- [Verification and Recovery](./verification-and-recovery.md)
