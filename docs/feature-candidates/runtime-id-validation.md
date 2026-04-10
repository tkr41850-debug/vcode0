# Feature Candidate: Runtime ID Validation and Factories

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline uses typed prefixed TypeScript aliases for graph identities:
- milestones: `m-${string}`
- features: `f-${string}`
- tasks: `t-${string}`

This keeps graph references scalar and lightweight in the domain model, APIs, snapshots, and persistence layer.

The baseline does **not** add dedicated runtime guards or factory helpers for these IDs yet. ID correctness beyond the prefix contract is therefore a caller discipline concern at runtime.

## Candidate

A later version could add:
- runtime guards such as `isMilestoneId()`, `isFeatureId()`, and `isTaskId()`
- factory helpers that mint typed ids from validated UUIDv7 payloads
- load-time validation for persisted snapshots and database rows
- tighter runtime parsing for malformed or cross-namespace references

## Why Deferred

This feature is deferred because it increases:
- helper/utility surface area in `@core/*`
- validation code at persistence and snapshot boundaries
- migration/update complexity if id-shape rules evolve
- implementation bulk before the graph core is even wired up

The typed alias baseline captures most of the value now with much less code. Runtime validation can be added later if malformed-id incidents or persistence-boundary bugs justify it.