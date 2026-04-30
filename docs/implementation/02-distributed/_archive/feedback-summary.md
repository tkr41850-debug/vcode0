# Feedback Summary — Phases 1-5 MVP Plan

Consolidated from feedback-opus-1, feedback-haiku-1 through feedback-haiku-5.
Ship order under review: 5 → 1 → 2 → 3 → 4.

## Blockers

### B1. Phase 5 step 5.1 internal contradiction on squash/transition order
- Files: `docs/implementation/01-baseline/phase-5-task-integration.md:28` vs `:33`.
- Line 28 says invoke `squashMergeTaskIntoFeature` "after `transitionTask(..., 'merged')`"; line 33 says "first call `squashMergeTaskIntoFeature`...; only call `transitionTask(..., 'merged')` on `{ ok: true }`."
- Patch: delete the "after `transitionTask(..., 'merged')`" clause at L28. Phase 4 (`phase-4-recovery.md:36`) presumes the squash-then-transition order.
- Flagged by: opus-1 (§4).

### B2. README Phase 2 row misrepresents scope and risk
- File: `docs/implementation/01-baseline/README.md:15`.
- Current: "`--force-with-lease` on integration merge" / "Risk: Low — single-line, optional unless multi-orchestrator". Phase 2 doc rejects that approach in favor of a 4-step plumbing CAS (`merge-base` → `merge-tree --write-tree` → `commit-tree` → `update-ref`), ~40-50 lines, with stderr CAS-failure parsing and a reroute path.
- Patch: change scope to "plumbing-based atomic CAS on `refs/heads/main`"; raise risk to "Medium — replaces working-tree merge with plumbing"; keep "optional unless multi-orchestrator" qualifier.
- Flagged by: opus-1 (§6), haiku-4 (§5).

### B3. `RebaseVerifyIssue.conflictedFiles` shape unspecified for two new emit sites
- Files: `phase-2-merge-train.md` (step 2.1, `main_moved` reroute) and `phase-5-task-integration.md:60+` (squash exhaustion reroute).
- `RebaseVerifyIssue` interface (`src/core/types/verification.ts:73-76`) requires `conflictedFiles: string[]`. Existing `main_moved` reroute (`src/orchestrator/integration/index.ts:142-150`) uses `conflictedFiles: []`. Neither phase doc states what to populate for "main moved" (no files conflicted) or "squash retries exhausted" (which iteration's snapshot?).
- Patch: Phase 2 spec must explicitly mirror `conflictedFiles: []`; Phase 5 spec must specify "last-attempt conflicted set".
- Flagged by: opus-1 (§3); haiku-5 (§2) confirmed shape but did not fix the unspecified payload.

### B4. Ship-order 5→1 still leaves stale Phase 1 line citations against post-Phase-5 layout
- Files: `phase-1-safety.md:128, 134, 146`.
- Phase 1 step 1.5 cites `events.ts:113-116`, `:449-451`, and "every existing call site that previously set `retryAt = now + 1000`". Confirmed against `src/orchestrator/scheduler/events.ts:116,451`. Phase 5 step 5.1 reorganizes `:84-105` and adds an inline retry loop that introduces additional `retryAt` sites Phase 1 will not anticipate.
- Patch: Phase 1 step 1.5 must (a) re-cite line numbers post-Phase-5, or (b) restate the rule structurally ("every error-path retry-decision site in `events.ts`") instead of by line. The review prompt at L146 must be reworded to enumerate sites by function/handler, not line.
- Flagged by: opus-1 (§1, §2).
- Note: haiku-1 (Pair 1↔5) and haiku-4 (§2) judge Phase 1↔5 line ranges non-overlapping and ship order sound. The blocker is the doc citation drift, not a code-level collision.

## Serious

### S1. Config field naming drift — `max_squash_retries` snake_case in camelCase codebase
- File: `phase-5-task-integration.md:60`.
- Existing config (`src/config.ts:62-68, 117-135, 303-312`; `src/core/types/config.ts:46-53`) uniformly camelCase: `tokenProfile`, `modelRouting`, `mcpServerPort`, `workerHealthTimeoutMs` (Phase 1 1.4).
- Patch: rename `max_squash_retries` → `maxSquashRetries` everywhere in Phase 5 doc.
- Flagged by: opus-1 (§3), haiku-2 (§1).

### S2. Two retry abstractions without shared vocabulary
- Files: `phase-1-safety.md:133` (`retryPolicy` block: `retryCap`, `baseDelayMs`, `jitterFraction`, transient-vs-semantic split) vs `phase-5-task-integration.md:54-62` (squash retry: `maxSquashRetries`, no exponential delay, no jitter, bypasses `decideRetry`).
- Patch: either Phase 5's loop should consume `RetryPolicy` (sharing `retryCap`, exponential delay), or Phase 1 should explicitly carve out squash-retry as a sibling concept and name it. State the relationship in both docs.
- Flagged by: opus-1 (§3); haiku-1 (Pair 1↔5) confirmed pre-emption is intentional but did not address the vocabulary gap.

### S3. `source: 'rebase'` collision between Phase 2 and Phase 5 reroutes
- Files: `phase-2-merge-train.md` step 2.1, `phase-5-task-integration.md:60+`.
- Both emit `RebaseVerifyIssue` with `source: 'rebase'` for distinct failure modes: Phase 2 = main advanced (concurrency loss), Phase 5 = squash retries exhausted (inherent conflict). Operators cannot disambiguate at planner intake by `source` alone.
- Patch: introduce `source: 'squash'` for Phase 5 step 5.2; keep `'rebase'` for Phase 2. Update `src/core/types/verification.ts` `RebaseVerifyIssue.source` union to include `'squash'` (or split into a sibling `SquashVerifyIssue`).
- Flagged by: haiku-5 (§1), opus-1 (§3, partly).

### S4. Phase 5 squash-exhaustion bypasses Phase 1 inbox-escalation contract
- Files: `phase-5-task-integration.md:54-62`, `phase-1-safety.md` step 1.6.
- Phase 1 promises every escalation path appends an `inbox_items` row (kinds: `semantic_failure | retry_exhausted | destructive_action`). Phase 5 step 5.2 routes squash exhaustion only through `rerouteToReplan`, no inbox row. Phase 1 step 1.7 (destructive ops) wires both `request_approval` IPC and `appendInboxItem`, setting the precedent.
- Patch: Phase 5 step 5.2 must append an `inbox_items` row of kind `'squash_retry_exhausted'` (or reuse `retry_exhausted`) alongside `rerouteToReplan`. README cross-phase conventions should also state the invariant.
- Flagged by: opus-1 (§4, §6), haiku-5 (§6).

### S5. Phase 5 task-squash failure not enumerated in `IntegrationOutcome` union
- Files: `phase-5-task-integration.md` step 5.1; reference `src/orchestrator/integration/index.ts:16-21` (kinds: `merged | rebase_conflict | main_moved | post_rebase_ci_fail | skipped`).
- Phase 5 introduces a logically equivalent failure (stuck task pre-merge) but routes through `rerouteToReplan` directly, not as an `IntegrationOutcome` variant.
- Patch: Phase 5 doc must explicitly decide and state: either add `'task_squash_failed'` to `IntegrationOutcome.kind`, or document why task-squash is not an integration outcome (it precedes integration-coordinator scope).
- Flagged by: opus-1 (§3); haiku-5 (§3) judged the union itself unmodified, but the design decision is still missing from Phase 5.

### S6. Phase 4 disposal vs Phase 5 transition ordering left ambiguous
- File: `phase-4-recovery.md:36` ("after the successful squash but before (or alongside) the transition").
- Two implementations could legitimately disagree on whether disposal precedes or runs alongside `transitionTask(..., 'merged')`.
- Patch: pin a single ordering. Recommended: dispose **after** `transitionTask(..., 'merged')` and log disposal failures non-fatally (Phase 4 already says async/non-blocking — see haiku-1 Pair 4↔5). Update L36 to drop the parenthetical.
- Flagged by: opus-1 (§4).

### S7. README Phase 4 row hides Phase 5 ship-order constraint
- File: `README.md:17`.
- Current: "Worktree disposal (feature-merge today; extend to task-squash after Phase 5)". Under recommended order 5→1→2→3→4, the "feature-merge today" hedge is unreachable.
- Patch: drop the "feature-merge today" hedge from the table cell; state inline that Phase 4's full design requires Phase 5 in place.
- Flagged by: opus-1 (§6); haiku-4 (§1) raised the same risk-rating concern (Phase-4-only operation escalates from Low to Medium).

### S8. Shared integration-test fixture coordination risk
- File: `test/integration/feature-phase-agent-flow.test.ts` (referenced by Phases 1, 3, 5).
- Phase 5 step 5.1 says "update if it asserts feature-branch tip equals main"; Phase 1 step 1.5 and Phase 3 step 3.1 also touch retry/dispatch behavior observable from this file.
- haiku-3 verified existing assertions at `:707-788` check `workControl: 'awaiting_merge' → 'work_complete'` (lines 730, 759), not feature-branch tip. So Phase 5's caveat is satisfied without changes — but the fixture is still touched by three phases.
- Patch: README cross-phase conventions should list `feature-phase-agent-flow.test.ts` as a multi-phase fixture and require coordinated test edits.
- Flagged by: opus-1 (§5), haiku-3 (existing-test impact).

## Nits

- N1. README ordering note buried in prose (`README.md:9`); table should restate "5 ships first" inline. (opus-1 §1, §6)
- N2. Phase 3 tick counter holds open across Phase 5's awaited retry loop — note explicitly in Phase 3 doc that this is acceptable under the counter scheme. (opus-1 §4)
- N3. Phase 3's exception-swallow at `events.ts:198-326` (called out at `phase-3-scheduler.md:50`) and Phase 1's retry-test surface may couple. Add a coordination note. (opus-1 §5)
- N4. README cross-phase conventions section missing `inbox_items` invariant (subsumed by S4 patch). (opus-1 §6)
- N5. README Phase 5 risk could be raised from "Medium" to "Medium-High" given `POST_EXECUTION_PHASES` change touches three audited consumer sites. (opus-1 §6)
- N6. `replan_needed` is used as a `VerificationOutcome`, a `ConflictResolution.kind`, and a test name (`dispatch.ts:776`). No collision but doc should confirm. (opus-1 §3)
- N7. Phase 1 step 1.2 and 1.6 say "extend" `test/unit/persistence/sqlite-store.test.ts` — confirm both use Edit, not Write (file already exists). (haiku-3)
- N8. Phase 5 step 5.2 currently has only an integration test (`task-squash-retry-cap.test.ts`) for the retry loop; add a unit test covering retry-decision math (cap behavior, rebase-then-retry sequencing). (haiku-3)
- N9. Phase 1 retry config: `retryPolicy` is a sub-object, not flat fields — make the structure explicit in `phase-1-safety.md:133`. (haiku-2 §5)
- N10. Phase 5 doc does not state where `maxSquashRetries` is read from; verify config flows through `OrchestratorPorts.config` (`src/orchestrator/ports/index.ts:81-89`) into the scheduler ctor used at the `events.ts:84-105` retry site. (haiku-2 §2)

## Cross-cutting themes

- **Vocabulary collisions on retry / reroute.** Two retry abstractions (Phase 1 `RetryPolicy` vs Phase 5 `maxSquashRetries`), two reroute sources sharing `'rebase'` (Phase 2 main-moved vs Phase 5 squash-exhausted), and two escalation conventions (Phase 1 inbox vs Phase 5 reroute-only). All three need a single unifying decision in the README cross-phase conventions section.
- **Config naming drift.** Snake_case `max_squash_retries` is the only camelCase violator in a uniformly camelCase config surface. Catch in lint, not in review.
- **`events.ts:84-105` is the load-bearing site.** Phases 1 (retry wrap, error path), 3 (tick wrap), 4 (disposal hook), and 5 (squash + transition reorder + retry loop) all converge here. Ship order 5→1→2→3→4 is sound (haiku-1, haiku-4 confirm) but Phase 1 doc citations were authored against the pre-Phase-5 layout and need re-citation post-merge of Phase 5.
- **Shared integration test fixture.** `test/integration/feature-phase-agent-flow.test.ts` is touched by Phases 1, 3, 5; needs explicit cross-phase coordination note.
- **Phase docs cite line numbers, not anchors.** Many findings reduce to "line numbers move when an earlier phase lands". Recommend Phase 1 (the most affected by Phase 5) restate edit sites by handler/function name rather than line.

## Verified-clean

- **Ship order 5 → 1 → 2 → 3 → 4 is sound.** No phase introduces a hard cycle; all cross-phase deps are forward-pointing under this order. (opus-1, haiku-1, haiku-4 independently confirmed)
- **Phase 1 ↔ Phase 5 line ranges do not overlap once Phase 5 reorder applied.** Phase 1 edits `:113-116` / `:449-451` (error path); Phase 5 reorders `:84-105` (success path). Independent. (haiku-1 Pair 1↔5, haiku-4 §2)
- **Phase 4 ↔ Phase 5 disposal hook is grafted on Phase 5's squash-success branch; no line collision.** (haiku-1 Pair 4↔5)
- **Phase 1 ↔ Phase 4 fully independent.** Phase 4 disposal edits live in `src/runtime/worktree/index.ts`, `src/core/merge-train/index.ts`, `src/orchestrator/features/index.ts` — not `events.ts`. (haiku-1 Pair 1↔4)
- **Phase 3 tick guard naturally encompasses Phase 5's squash call.** Tick wrapper sits at scheduler tick entry/exit; Phase 5 squash runs inside the body. No collision. (haiku-1 Pair 3↔5, haiku-4 §4)
- **Phase 2 self-contained.** Plumbing CAS works on both empty and populated feature branches; no Phase 5 prerequisite. (haiku-4 §3)
- **IPC frame additions in Phase 1 (`health_ping` / `health_pong`) collide with no existing variant.** Verified against `src/runtime/contracts.ts:339-467` (10 + 7 existing variants). (haiku-2 §3)
- **Worker-side git-free invariant holds.** `src/agents/worker/tools/submit.ts:31-34` and `confirm.ts:18-24` perform no git ops. Phase 5's "merge belongs to orchestrator" constraint is honored. (haiku-2 §4)
- **`RebaseVerifyIssue` base shape is intact.** `description` field exists on `VerifyIssueBase`; `conflictedFiles` is present in all callsites. (haiku-5 §2 — payload still unspecified, see B3, but interface itself is fine.)
- **`agent_runs` row state vs task enum invariant preserved.** Phase 5 retry counter is local to the handler, not persisted as a task field. Phase 1 retry state is per-tick, not per-task. (haiku-5 §4)
- **Control field names consistent.** `collabControl`, `workControl`, `suspendReason` (not `suspendedReason`) all match codebase. No `runtimeControl` field exists or is introduced. (haiku-5 §5)
- **Dropped-from-MVP claims verified.** Worker PID registry, resume facade, commit-trailer drop, `executing_repair` absence — all match the README. (haiku-4 §6)
- **`POST_EXECUTION_PHASES` fix in Phase 5 step 5.3 is a real bug fix in existing code, not a phase-interaction issue.** (haiku-2 §6)
