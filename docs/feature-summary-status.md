# Feature Summary Status

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Purpose

This document defines how post-merge feature summarization is recorded, including the budget-mode case where the summary phase is intentionally skipped.

## Baseline States

```ts
type FeatureSummaryStatus = "pending" | "completed" | "skipped_summary";
```

- `pending` — feature has not yet reached its summary outcome
- `completed` — a post-merge summary was written successfully
- `skipped_summary` — budget-mode flow intentionally skipped generating the post-merge summary

## Baseline Rule

After collaboration control reaches `merged`:
- normal flow enters `summarizing`, then moves to `work_complete` with `summaryStatus = "completed"`
- budget-mode flow may skip the summarization phase and move directly to `work_complete` with `summaryStatus = "skipped_summary"`

This preserves one consistent completion rule: merged features still reach `work_complete`, but the system records whether a real summary was written.

## Why This Exists

`work_complete` should mean the feature is done from the orchestrator's perspective. Without a separate summary outcome, skipping summarization in budget mode creates a semantic conflict with the normal blocking-summary path.

## Related

- [Data Model](./data-model.md)
- [Budget and Model Routing](./budget-and-model-routing.md)
- [Verification and Recovery](./verification-and-recovery.md)
