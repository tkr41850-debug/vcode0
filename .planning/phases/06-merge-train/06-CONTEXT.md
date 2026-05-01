# Phase 6: Merge Train - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 6 closes the strict-main integration loop for merge-ready features: once a feature reaches `awaiting_merge`, the orchestrator must serialize it through the merge train, rebase it onto the latest `main`, run merge-train verification as an agent review, and either merge it or eject it into repair/replan flow without letting `main` advance in an unverified state. This phase also turns the documented re-entry cap and inbox parking behavior into real enforced runtime behavior, not just warnings or docs.

Already present from earlier phases: features can reach `awaiting_merge`, queue ordering fields persist, the scheduler auto-promotes `awaiting_merge` features into `merge_queued` then `integrating`, verify failures already fan out into concrete repair tasks, and trailer-backed commit auditing now exists for task completions. Phase 6 must finish the integration-specific parts that remain partial: integration verification/ejection semantics, hard re-entry-cap enforcement with diagnostics, and cross-feature conflict handoff around merge-train exits.

</domain>

<decisions>
## Implementation Decisions

### Queue Ordering and Integration Ownership
- Keep `src/core/merge-train/index.ts` as the queue-ordering source of truth. Its ordering contract is already locked: `mergeTrainManualPosition` first, then `mergeTrainReentryCount` descending, then `mergeTrainEntrySeq` FIFO.
- Keep the scheduler-owned integration start point in `src/orchestrator/scheduler/index.ts`, where each tick already calls `features.beginNextIntegration()` after event handling and summary reconciliation.
- Treat `collabControl='integrating'` as the single active merge-train slot. No Phase 6 work should introduce parallel integration or speculative verification; strict serial behavior remains the invariant.
- Preserve the current split of responsibilities: core merge-train code decides queue legality and ordering, while orchestrator code decides failure routing, repairs, inbox escalation, and cross-feature release side effects.

### Rebase + Merge-Train Verify + Eject-or-Merge Protocol
- Merge-train verification should reuse the Phase 5 verify-agent contract rather than inventing a separate verification mode. The same `VerificationSummary`/`VerifyIssue` structure should drive pass vs repair-needed outcomes.
- Queue-head integration must follow the documented strict-main sequence: rebase onto latest `main`, run agent review against the rebased integration diff, then either emit `feature_integration_complete` or `feature_integration_failed` without advancing `main` on failure.
- Integration-stage failures should continue routing through orchestrator-owned repair tasks with `repairSource='integration'`; Phase 6 should extend this path with richer diagnostics rather than replacing it.
- Feature exit on integration failure should remain `integrating → conflict` followed by repair/re-entry, but the failure payload must distinguish why the feature was ejected: rebase conflict, post-rebase coordination block, or merge-train verify failure.

### Re-entry Counting, Cap, and Parking
- Phase 6 should make the documented cap behavior real: default cap 10, configurable, enforced on enqueue/re-entry rather than merely warned about.
- Use `mergeTrainReentryCount` as the canonical persisted counter. It already exists in types, codecs, persistence, warnings, and queue ordering.
- Preserve the current biasing behavior where higher re-entry counts sort earlier; Phase 6 adds a hard stop at cap instead of removing that priority.
- When the cap is reached, do not requeue the feature. Park it via an inbox item with merge-train diagnostics instead of allowing infinite churn.
- Treat `> cap` as a recovery/anomaly path: startup or reconciliation code should park the feature rather than silently continuing.

### Manual Override and User Steering
- Keep the v1 override model simple: `mergeTrainManualPosition` is the only manual queue-priority input for Phase 6.
- Manual position stays advisory within the strict serial queue; it may reorder queued features but must not bypass dependency legality, verification, or cap rules.
- Clearing queue-local fields on merge/eject remains correct; Phase 6 should preserve that cleanup behavior while keeping lifetime re-entry history intact.
- Any richer manual ordering UX remains Phase 8+ scope; Phase 6 only has to make the existing field operational and trustworthy.

### Cross-Feature Conflict Handoff
- Reuse the existing cross-feature overlap coordinator in `src/orchestrator/conflicts/cross-feature.ts` rather than adding a separate merge-train-specific conflict system.
- Keep the current pattern where integration completion releases blocked secondary features, then either resumes them or creates integration repair work when reconciliation fails.
- Phase 6 should make the merge-train failure path symmetric with the success path where needed: if integration exits due to conflict or verify failure, blocked secondaries must not be silently starved.
- Cross-feature conflict handling is considered complete for this phase only when the conflict protocol is observable in tests, not merely when `runtimeBlockedByFeatureId` fields mutate.

### Diagnostics and Inbox Surfacing
- Re-entry-cap parking must produce a real inbox payload via `appendInboxItem`, not just an event or warning. The payload should include enough diagnostics for the user to understand the repeated failure pattern.
- Warning signals such as `feature_churn` remain advisory. Phase 6 should not overload warnings as the enforcement mechanism.
- Integration failures that become repair work should preserve actionable summaries for the generated repair task descriptions; cap parking should preserve the broader history and counts for human decision-making.
- Phase 6 may continue using the existing inbox stub schema from Phase 3/5 so long as the payload is explicit and testable.

### Claude's Discretion
- Exact event names and payload shapes for new merge-train diagnostics are at Claude's discretion so long as they remain consistent with existing append-only event patterns and inbox-item contracts.
- Whether merge-train verification is triggered via a feature-phase agent reuse path or a dedicated integration runner is at Claude's discretion, provided the resulting contract still satisfies REQ-MERGE-04 as an agent review and keeps `main` strict.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/merge-train/index.ts` already provides queue legality, ordering, integration entry, completion, and ejection helpers over persisted merge-train fields.
- `src/orchestrator/features/index.ts` already bridges lifecycle success into `awaiting_merge`, enqueues features into the merge train, and routes integration failures into `repairSource='integration'` tasks.
- `src/orchestrator/scheduler/index.ts` already calls `features.beginNextIntegration()` every tick, so merge-train advancement is already scheduler-driven.
- `src/orchestrator/scheduler/events.ts` already handles `feature_integration_complete` and `feature_integration_failed`, releases cross-feature overlap blocks after integration completion, and creates integration repairs when release/reconcile fails.
- `src/orchestrator/conflicts/cross-feature.ts` already suspends blocked secondaries, rebases/resumes them after primary completion, and returns structured `blocked` / `repair_needed` / `resumed` outcomes.
- Phase 5 verify infrastructure is already available: feature-phase verification summaries, issue fan-out into repair tasks, and trailer-backed task completion corroboration.

### Established Patterns
- Graph mutations must stay inside the serial scheduler tick. Orchestrator helpers own graph changes; agents stay review/proposal-oriented.
- Failure routing uses explicit work-control transitions plus concrete repair tasks rather than implicit retries of whole phases.
- Persisted audit fields and counters live on the feature or run records first, then warnings/events/inbox items are derived from that stored state.
- Scheduler tests often prove contracts through event-driven state transitions in one tick, especially around phase completion and integration handoff.
- Cross-feature coordination prefers suspend/reconcile/resume over ad-hoc starvation or dropping blocked work.

### Integration Points
- `src/core/merge-train/index.ts` for queue order, ejection, and state cleanup.
- `src/orchestrator/features/index.ts` for re-entry counting, integration-repair creation, and lifecycle-to-merge-train handoff.
- `src/orchestrator/scheduler/events.ts` for integration success/failure event handling, inbox/event diagnostics, and cross-feature release reactions.
- `src/orchestrator/scheduler/index.ts` and `src/orchestrator/scheduler/helpers.ts` for when integration work is advanced each tick.
- `src/core/warnings/index.ts` plus docs under `docs/foundations/coordination-rules.md` and `docs/concerns/merge-train-reentry-cap.md` for the already-documented but not-yet-enforced cap contract.
- Existing tests in `test/unit/core/merge-train.test.ts`, `test/integration/merge-train.test.ts`, and `test/unit/orchestrator/scheduler-loop.test.ts` provide the current baseline and show where the Phase 6 gaps still need acceptance coverage.

</code_context>

<specifics>
## Specific Ideas

- The docs already commit to stronger behavior than the runtime currently enforces: `docs/foundations/coordination-rules.md` specifies a default re-entry cap of 10 with inbox parking at the cap, while `docs/concerns/merge-train-reentry-cap.md` explicitly says the code is still uncapped today. Phase 6 should resolve that mismatch.
- Current queue ordering is already implemented and tested, including manual position and re-entry prioritization. Phase 6 should avoid rewriting that logic unless a test proves a concrete contract gap.
- The scheduler already moves a verify-success feature through `awaiting_merge → merge_queued → integrating` in one tick (`test/unit/orchestrator/scheduler-loop.test.ts`). That means Phase 6 planning should focus on what happens while integrating and on exit, not on the initial queue admission path alone.
- `feature_integration_complete` / `feature_integration_failed` are already consumed in scheduler events, but the repo currently shows consumers much more clearly than producers. That suggests Phase 6 likely needs to harden or complete the integration runner/executor side rather than just the event reducer side.
- Cross-feature release after integration already exists and can synthesize new integration repair tasks when rebasing blocked secondaries fails. Phase 6 should preserve this pattern and test that it prevents silent starvation in real merge-train scenarios.

</specifics>

<deferred>
## Deferred Ideas

- Merge-train throughput optimizations such as speculative parallel rebase+verify or batch merges remain explicitly deferred to v2 (`REQ-MERGE-V2-01/02`).
- Richer arbitrary persistent manual ordering remains v2 scope; v1 stays with the simple `mergeTrainManualPosition` bucket.
- TUI-level queue control and inbox presentation polish remain Phase 8+ work; Phase 6 only needs the underlying queue, diagnostics, and inbox payloads to be correct.

</deferred>
