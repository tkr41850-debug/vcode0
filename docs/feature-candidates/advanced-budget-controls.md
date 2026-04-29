# Feature Candidate: Advanced Budget Controls

## Status

Future feature candidate. Do not treat this as part of baseline architecture yet.

## Baseline

Baseline budget governance should stay simple:

- global spend rollup comes from persisted run usage
- one global warning threshold surfaces budget pressure
- one global limit blocks **new dispatch only** once crossed
- already-running work is not suspended or killed by budget limit
- task-level spend visibility remains advisory
- no per-milestone / per-feature / per-task overrides yet
- no average-based budget policies yet

This keeps first-pass budget behavior cheap to reason about and avoids mixing cost governance with advanced runtime control semantics.

## Candidate

Add hierarchical budget controls with distinct **warn** and **limit** levels at multiple scopes, plus explicit overrides.

Potential scope surfaces:

- global total spend
- milestone total spend
- milestone average feature spend
- feature total spend
- feature average task spend
- task total spend

Potential policy surfaces:

- `warn` level emits advisory warnings only
- `limit` level blocks new dispatch at the matching scope
- optional explicit override records for milestone / feature / task

Rough config shape:

```jsonc
{
  "budget": {
    "global": { "warnUsd": 40, "limitUsd": 50 },
    "milestoneDefaults": {
      "warnUsd": 10,
      "limitUsd": 15,
      "featureAverageWarnUsd": 2,
      "featureAverageLimitUsd": 3
    },
    "featureDefaults": {
      "warnUsd": 4,
      "limitUsd": 6,
      "taskAverageWarnUsd": 1,
      "taskAverageLimitUsd": 1.5
    },
    "taskDefaults": { "warnUsd": 1.5, "limitUsd": 2 },
    "overrides": {
      "milestones": {
        "m-1": { "warnUsd": 12, "limitUsd": 18 }
      },
      "features": {
        "f-1": { "warnUsd": 6, "limitUsd": 8 }
      },
      "tasks": {
        "t-1": { "warnUsd": 2, "limitUsd": 3 }
      }
    }
  }
}
```

This draft is intentionally rough. Exact naming, precedence, and enforcement semantics need later design discussion.

## Open Design Questions

- How should override precedence work across global, milestone, feature, and task scopes?
- Should average-based limits use lifetime totals only, or recent-window spend too?
- Should crossing a scope limit block only new work in that scope, or also influence routing elsewhere?
- How should milestone and feature averages behave for very small sample sizes?
- Should warning levels feed model-routing pressure automatically, or remain advisory only?

## Why Deferred

Advanced budget control adds policy complexity quickly:

- override precedence is easy to misread in operator UX
- average-based signals need careful semantics to avoid noisy false pressure
- scope-local limit behavior must stay coherent with scheduler fairness and merge-train flow
- richer budget control overlaps with future runtime pause/suspend ideas, but should not require them

Until concrete operator pain appears, baseline global warning plus global block-new-dispatch limit is simpler and safer.
