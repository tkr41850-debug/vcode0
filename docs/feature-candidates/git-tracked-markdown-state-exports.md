# Feature Candidate: Git-Tracked Markdown State Exports

## Status

Future feature candidate. Do not treat this as part of baseline architecture yet.

## Baseline

Current baseline keeps authoritative live orchestration state in SQLite at `.gvc0/state.db`.
That includes DAG state, work control, collaboration control, shared run state, and other scheduler-facing fields.
Filesystem `.json` and `.ndjson` remain sidecar formats for generated snapshots, config, traces, and logs rather than replacing current-state DB authority.

Current repo also has real Markdown sidecars in `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md`.
Those files are append-only human-oriented records rather than a normalized mirror of current feature/task state.
They also live under `.gvc0/`, which is currently gitignored.

Current baseline therefore has no repo-tracked, human-readable mirror of feature/task state that can be reviewed in git alongside code changes.

## Candidate

A later version could continuously mirror stable, human-meaningful feature and task state into repo-tracked Markdown files while keeping SQLite as source of truth for live orchestration.

Potential capabilities:
- one feature state file per feature plus task state files that link back to owning feature
- reciprocal links from feature files to task files for easier audit and navigation
- markdown exports focused on stable, low-churn state rather than volatile runtime internals
- visible stale marking when mirrored files are no longer current or can no longer be trusted as fresh exports
- continuous export updates on feature/task state changes for transparency during active work
- separate git workflow controls so mirrored files may be committed, staged, or left as working-tree changes only at manual checkpoints or significant lifecycle events
- intentionally possible rebuild/bootstrap of usable graph state from markdown exports when DB is unavailable or work moves across devices

This candidate is additive transparency and recovery support.
It does not replace SQLite as authoritative live state, and it does not imply exact reconstruction of all runtime/session details from markdown alone.

## Open Questions

If this candidate is pursued later, main design questions to resolve are:

1. **Export layout and naming**
   - What tracked directory should hold mirrored feature and task files?
   - Should filenames key off ids only, slugs only, or both?
   - Should feature files embed task summaries, or only link task files?

2. **Freshness and stale marking**
   - What exact conditions mark an export stale?
   - Should stale mean lagging behind DB version, schema mismatch, deleted-at-source, failed export, or some combination?
   - How should stale state appear in user-facing markdown?

3. **Export trigger and cadence**
   - Should mirrored files rewrite on every durable state transition, on coarser checkpoints, or through mixed policy?
   - Which updates are important enough for continuous transparency, and which are too noisy?
   - How should export writes interact with multi-task parallelism without creating avoidable churn?

4. **Exported field boundary**
   - Which feature/task fields are stable and human-meaningful enough to mirror into markdown?
   - Which fields must remain DB-only because they are volatile, implementation-specific, or too noisy in git?
   - How much duplication is acceptable between feature files and task files?

5. **Rebuild semantics**
   - What minimum graph and lifecycle state should be reconstructable from markdown exports?
   - Which run/session/event details are intentionally unrecoverable from markdown alone?
   - Should rebuild exist only for disaster recovery, or also as normal bootstrap/import path?

6. **Git workflow integration**
   - Which manual checkpoints or significant lifecycle events should trigger staging or commit behavior?
   - Should mirrored state live on normal working branches, dedicated state branches, or both?
   - How should merge conflicts in mirrored state files be handled when code branches diverge?

## Why Deferred

This is deferred because current baseline already has clear authoritative persistence in SQLite, and current markdown sidecars cover narrower append-only knowledge/decision use cases without introducing mirrored state.
A repo-tracked markdown mirror would add useful transparency, git review visibility, and cross-device recovery value, but it would also add duplicated state that must stay coherent with DB truth.
Stale marking, export churn, branch behavior, and lossy rebuild boundaries all need deliberate design before this becomes baseline-worthy.

## Related

- [Architecture / Persistence](../architecture/persistence.md) — authoritative live state, filesystem sidecars, and session persistence model
- [Reference / Knowledge Files](../reference/knowledge-files.md) — existing markdown sidecars and their current role
- [Feature Candidate: Centralized Conversation Persistence](./centralized-conversation-persistence.md) — nearby persistence and recovery trade-offs
- [Feature Candidate: Distributed Runtime](./distributed-runtime.md) — future portability and recovery concerns across machines
