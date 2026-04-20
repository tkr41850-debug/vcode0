# Feature Candidate: Centralized Conversation Persistence

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

Current baseline already shares one persisted session pointer model for both task and feature-phase runs:
- `agent_runs.session_id` is authoritative resumable pointer
- current local backing store is filesystem-based `FileSessionStore` under `.gvc0/sessions/`
- both task execution and feature phases persist message history through that same local session-store seam

What is still *not* centralized is richer conversation management beyond that local file-backed store: no dedicated session service, no provider-agnostic checkpoint model beyond stored message transcripts, and no richer cross-runtime ownership/query layer.

## Candidate

A later version could replace current local file-backed session storage with richer centralized conversation persistence for all orchestrated agent work, including task execution runs and feature phases.

Potential capabilities:
- one orchestrator-owned conversation/session persistence layer for both task and feature-phase runs
- shared resume semantics across task workers, planner, replanner, discuss, research, verify, and summarize phases
- provider-agnostic storage and retrieval of conversation transcripts, checkpoints, and metadata
- cleaner crash recovery because all resumable agent work would use one persistence contract
- less filesystem-specific session handling and easier migration away from per-project local session files
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

This is deferred because current local `FileSessionStore` plus shared `agent_runs.session_id` semantics already cover baseline recovery needs. Bigger remaining gaps are around coordination and coverage, not lack of a central session service. Candidate becomes interesting only when local file-backed transcripts stop being sufficient for provider-agnostic recovery, richer ownership, or distributed runtime support.

## Related

- [Worker Model](../architecture/worker-model.md) — baseline task session recovery and feature-phase recovery assumptions
- [Architecture / Persistence](../architecture/persistence.md) — durable state ownership and `agent_runs` semantics
- [Operations / Verification and Recovery](../operations/verification-and-recovery.md) — retry, waits, and crash recovery behavior
- [Feature Candidate: Distributed Runtime](./distributed-runtime.md) — future runtime/session routing expansion
