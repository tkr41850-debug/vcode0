# Feature Candidate: Centralized Conversation Persistence

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The current baseline uses two persistence patterns:
- task execution resumes from authoritative `agent_runs.session_id` through the task runtime/session harness
- planner/replanner-style feature phases are assumed to persist their own conversation state to disk so they can resume after restart without requiring a centralized shared conversation store

This keeps task-runtime session recovery explicit while avoiding an immediate need to unify all task and feature-phase conversation persistence behind one subsystem.

## Candidate

A later version could centralize conversation persistence for all orchestrated agent work, including task execution runs and feature-phase planner/replanner runs.

Potential capabilities:
- one orchestrator-owned conversation/session persistence layer for both task and feature-phase runs
- shared resume semantics across task workers, planner, replanner, discuss, research, verify, and summarize phases
- provider-agnostic storage and retrieval of conversation transcripts, checkpoints, and metadata
- cleaner crash recovery because all resumable agent work would use one persistence contract
- less duplication between task harness session persistence and planner/replanner disk-backed conversation persistence
- easier future migration to alternate backends or external session services

## Migration Questions

If this candidate is pursued later, the main design questions to resolve are:

1. **Canonical persistence surface**
   - Should all resumable agent work persist through `agent_runs.session_id`, or should there be a richer session/conversation record?
   - How should provider-specific state map onto a provider-agnostic recovery contract?

2. **Storage format**
   - Should transcripts/checkpoints live in SQLite, filesystem documents, or a hybrid model?
   - Which pieces must be queryable versus opaque blobs?

3. **Recovery semantics**
   - What is the minimum checkpoint needed for correct resume?
   - Which phases must support exact continuation versus restart-from-context rebuild?

4. **Concurrency and ownership**
   - How should live ownership be tracked when a conversation may be resumed by different orchestrator components?
   - How does manual takeover interact with centralized persistence?

5. **Provider abstraction**
   - How should pi-sdk-native sessions, Claude Code sessions, and future providers plug into one persistence model?
   - Which provider details remain opaque, and which must be normalized?

## Why Deferred

This is deferred because baseline orchestrator work still has more urgent gaps: same-feature conflict coordination, task-run recovery, and integration coverage for settled behavior. Assuming planner/replanner phases persist their own conversation state to disk is sufficient for current recovery planning without forcing a broader persistence architecture decision.

## Related

- [Worker Model](../worker-model.md) — baseline task session recovery and feature-phase recovery assumptions
- [Architecture / Persistence](../architecture/persistence.md) — durable state ownership and `agent_runs` semantics
- [Operations / Verification and Recovery](../operations/verification-and-recovery.md) — retry, waits, and crash recovery behavior
- [Feature Candidate: Distributed Runtime](./distributed-runtime.md) — future runtime/session routing expansion
