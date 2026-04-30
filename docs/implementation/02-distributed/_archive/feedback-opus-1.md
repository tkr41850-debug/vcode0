# feedback-opus-1 — inter-phase consistency audit

## 1. Phase ordering claims

**[blocker] README ship order (5 → 1 → 2 → 3 → 4) collides with Phase 1 scope.** README.md:9, README.md:13 both endorse "Phase 5 first." But Phase 1 step 1.5 (phase-1-safety.md:128, 134) edits exactly the same lines (`events.ts:113-116`, `:449-451`) that Phase 5 step 5.1 (phase-5-task-integration.md:33) restructures by rewriting the `:84-105` `taskLanded` handler. Phase 1 was authored against the pre-Phase-5 layout (`retryAt: Date.now() + 1000` at `:116` and `:451` — confirmed in `src/orchestrator/scheduler/events.ts:116,451`). Phase 5 reorganises `:84-105` and adds an inline retry loop in the same handler (phase-5-task-integration.md:61). If 5 ships first, Phase 1's step 1.5 line citations and "every existing call site that previously set `retryAt = now + 1000`" review prompt (phase-1-safety.md:146) become stale.

**[serious] Phase 4 → Phase 5 dependency is asserted but partially under-specified.** phase-4-recovery.md:7,14,31 explicitly depend on Phase 5's squash transition for the task-disposal hook. Good. But README.md:13–17 lists items in numeric order with the 5-first note buried in the prose at README.md:9 only; the table itself says Phase 4 risk is "Low — additive lifecycle methods" without flagging the cross-phase dependency. A reader skimming the table would not see the gate.

**[serious] Phase 2 does not collide with Phase 5 in `events.ts`.** Phase 2 only touches `src/orchestrator/integration/index.ts:137-159` (phase-2-merge-train.md:9, 41). It does **not** touch `events.ts`. Confirmed safe.

**[nit] Phase 1 safety before Phase 5.** Per README.md:9, 1 ships after 5. Phase 1's heartbeat / retry-policy / IPC validation work has no logical dependency on Phase 5's squash; the order constraint is purely about avoiding rebase pain. This is fine, but README should say so explicitly.

## 2. Same-file edits across phases

| File | Phases | Collision |
|---|---|---|
| `src/orchestrator/scheduler/events.ts` | 1 (steps 1.5, 1.6, 1.7), 3 (assertions only — read-only audit), 4 (step 4.1 hook around `:465`), 5 (steps 5.1, 5.2) | **Severe.** See §1 above. |
| `src/config.ts` | 1 (steps 1.4 `workerHealthTimeoutMs`, 1.5 `retryPolicy`), 5 (step 5.2 `max_squash_retries`) | **Serious naming drift** — see §3. |
| `src/orchestrator/integration/index.ts` | 2 (step 2.1, replaces `:158-159`), 4 (step 4.1, hooks `:173` `completeIntegration` for feature-worktree disposal — phase-4-recovery.md:38) | **Low.** Different lines (`:158-159` vs `:173`); coexist cleanly. |
| `src/orchestrator/integration/reconciler.ts` | 4 only (`:97`) | No collision. |
| `src/runtime/worktree/index.ts` | 4 only (steps 4.1, 4.2). Phase 5 does **not** touch this file. |
| `src/orchestrator/scheduler/dispatch.ts` | 3 (step 3.2, dispatch loop `:814-841`), 4 (referenced for sweep-ordering reasoning). No write collision. |
| `src/orchestrator/conflicts/git.ts` | 5 only (step 5.1 adds `squashMergeTaskIntoFeature`). |
| `src/runtime/contracts.ts` | 1 only (steps 1.1, 1.4). |
| `src/runtime/ipc/index.ts` | 1 only (steps 1.1, 1.3). |
| `src/runtime/harness/index.ts` | 1 only (steps 1.3, 1.4). |
| `src/compose.ts` | 1 (steps 1.3, 1.4), 3 (step 3.1, multiple wrap sites at `:87, 90, 358-389, 458`), 4 (step 4.2 boot block `:249-253`) | **Manageable.** Distinct functions; merge order matters but no line collision. |
| `src/persistence/db.ts` | 1 only (registers migrations 010, 011). |

## 3. Vocabulary / contract collisions

**[serious] Config field naming inconsistency.** Phase 1 step 1.4 introduces `workerHealthTimeoutMs` (camelCase). Phase 1 step 1.5 introduces `retryPolicy` block (camelCase). Phase 5 step 5.2 introduces `max_squash_retries` (snake_case). The existing codebase config (`src/core/types/config.ts:46-53`, `src/config.ts`) is uniformly camelCase. **Fix:** rename to `maxSquashRetries`.

**[serious] `RetryPolicy` (Phase 1) vs `max_squash_retries` (Phase 5) overlap.** Phase 1 step 1.5 introduces a generic `RetryPolicy` (`retryCap`, `baseDelayMs`, `jitterFraction`, transient-vs-semantic split). Phase 5's squash retry is also a "retry" but uses an entirely separate config knob and bypasses `decideRetry`. Two retry abstractions, no shared vocabulary. Either Phase 5's loop should consume `RetryPolicy` (with `retryCap` and exponential delay) or Phase 1 should explicitly carve out squash-retry as a sibling concept.

**[blocker] `RebaseVerifyIssue` reuse in Phase 2 vs Phase 5.** Phase 2 step 2.1 emits a `RebaseVerifyIssue` with `source: 'rebase'` and a `description` mentioning `main_moved`. Phase 5 step 5.2 emits `source: 'rebase'` with description "task X failed to squash-merge after N attempts". The existing `RebaseVerifyIssue` interface (`src/core/types/verification.ts:73-76`) requires a `conflictedFiles: string[]` field. Neither phase doc specifies what `conflictedFiles` to populate when the failure is "main moved" (no files conflicted) or "squash retries exhausted" (files conflicted, but on which iteration's snapshot?). The existing `main_moved` reroute (`src/orchestrator/integration/index.ts:142-150`) already uses `conflictedFiles: []` — Phase 2 should explicitly mirror this, and Phase 5 should specify (likely the last-attempt conflicted set).

**[serious] `IntegrationOutcome.kind` rule restated correctly but inconsistently surfaced.** Phase 2 step 2.1 correctly notes `main_moved` is an `IntegrationOutcome.kind`, not a `VerifyIssue` discriminator (verified at `src/orchestrator/integration/index.ts:16-21`). Phase 5 introduces a *new* failure mode (`squash retries exhausted`) and routes through `rerouteToReplan` directly — but does **not** update the `IntegrationOutcome` union, even though logically a stuck task is an integration-coordinator-equivalent failure at the *task* layer. Decide explicitly: is task-squash failure an `IntegrationOutcome` variant (`'task_squash_failed'`)?

**[nit] `replan_needed` semantics.** Used in three contexts: `VerificationOutcome`, `ConflictResolution.kind`, `dispatch.ts:776` test. Both Phase 2 and Phase 5 route through `rerouteToReplan` which is the lifecycle-coordinator method, not a `kind` value. No collision, but confirm.

## 4. Hook ordering across phases

The `events.ts:84-105` task-success handler is the load-bearing site. Four phases want to inject behaviour:

- **Phase 5 step 5.1**: squash *first*, then `transitionTask(..., 'merged')` only on success.
- **Phase 5 step 5.2**: on conflict, retry inline up to `max_squash_retries`.
- **Phase 4 step 4.1**: dispose task worktree *after* `squashMergeTaskIntoFeature` returns `{ ok: true }`, before `transitionTask(..., 'merged')`.
- **Phase 1 step 1.5**: wraps the *error* path (`message.type === 'error'` at `events.ts:108`), not the `result` path. **No direct collision** with Phases 4/5.
- **Phase 3 step 3.1**: wraps the entire `tick()` body in `__enterTick`/`__leaveTick`.

**[blocker] Phase 5 step 5.1 internal contradiction.** phase-5-task-integration.md:28 says "Invoke it from the task-success path in `events.ts` **after** `transitionTask(..., 'merged')`" — but phase-5-task-integration.md:33 says "**first** call `squashMergeTaskIntoFeature`...; only call `transitionTask(..., 'merged')` on `{ ok: true }`." The two sentences disagree on order. Phase 4's hook plan (phase-4-recovery.md:36) is explicit that the squash returns ok *before* the transition fires, so the :33 phrasing is the intended one. **Fix:** delete the misleading "after" clause at line 28.

**[serious] Phase 1 retry-policy escalation vs Phase 5 squash-retry loop semantics.** Phase 1's `decideRetry` operates on the `error` IPC frame branch (`events.ts:108-122`); Phase 5's loop operates on the `result+squash-conflict` branch (newly created in 5.1). They are mutually exclusive code paths today, **but** Phase 5 step 5.2 says "leave the task non-merged and call `features.rerouteToReplan` on exhaustion" — which is escalation without a corresponding `inbox_items` row. Phase 1 step 1.6 implies every escalation lands in `inbox_items`. Phase 5's exhaustion path is an escalation that bypasses the inbox. **Fix:** Phase 5 step 5.2 should also append an `inbox_items` row of kind `'squash_retry_exhausted'` (or analogous), matching the Phase 1 promise.

**[serious] Phase 4 disposal order vs Phase 5 transition.** phase-4-recovery.md:36 specifies disposal "immediately after the successful squash but before (or alongside) the transition." This is correct, but the parenthetical "(or alongside)" leaves room for two implementations to disagree. Pin it: dispose **before** `transitionTask(..., 'merged')` so any disposal failure surfaces in the same tick as a logged warning, before state commits — or **after**, accepting the inverse.

**[nit] Phase 3 tick-wrap interaction.** Phase 3's `__enterTick`/`__leaveTick` wraps the *whole* tick body, so Phase 5's nested calls (squash + transitionTask + retry loop) all run inside one tick. The counter design supports this. No collision, but Phase 5's retry loop holds the tick open across multiple awaits — the doc should explicitly note this is acceptable under the counter scheme.

## 5. Test fixture collisions

**[serious] `test/integration/feature-phase-agent-flow.test.ts` reused across phases without coordination.** Phase 5 step 5.1 says "update if it asserts feature-branch tip equals main (it shouldn't after this change)". The same test is referenced as already passing on `main`. After Phase 5, any test in that file that pre-supposes "feature branch == empty" will break. Phase 1's step 1.5 and Phase 3's step 3.1 also touch retry/dispatch behaviour observable from this test.

**[nit] Phase 3's silently-swallowed assertion.** phase-3-scheduler.md:50 calls out that `events.ts:198-326` swallows exceptions. Phase 1 step 1.5 will modify the same surrounding handler. If a Phase 1 retry test relies on observing thrown errors from `decideRetry`, it must coordinate with Phase 3's test that depends on the swallow remaining in place.

**[nit] `test/integration/two-tasks-conflict-then-resolve.test.ts`.** Phase 5 references this test in 5.1 and extends it in 5.2. Self-consistent within Phase 5.

## 6. README accuracy

**[blocker] Phase 2 row in README.md:15 misrepresents scope.** README claims Phase 2 is `--force-with-lease on integration merge`, `Risk: Low — single-line, optional unless multi-orchestrator`. The actual phase doc opens by **disproving** that approach. The redesign is a four-step plumbing sequence (`merge-base` → `merge-tree --write-tree` → `commit-tree` → `update-ref`), removes the existing `mainGit.checkout` + `mainGit.merge` pair, requires git ≥ 2.38, and contains conflict handling + new error parsing. Risk is no longer "single-line"; it is "rewrite of the merge step" with a working-tree-mutation regression risk. **Fix:** update README scope to "plumbing-based atomic CAS on `refs/heads/main`" and risk to "Medium — replaces working-tree merge with plumbing".

**[serious] README.md:17 Phase 4 row underdescribes the Phase 5 dependency.** "Worktree disposal (feature-merge today; extend to task-squash after Phase 5)" is correct but the recommended ship order in README.md:9 is `5 → 1 → 2 → 3 → 4`, so by the time Phase 4 ships, Phase 5 is in. The "feature-merge today" hedge is therefore unreachable under the recommended order. Either drop the hedge from the table or restate the order constraint inline.

**[nit] README.md:13 Phase 5 risk wording.** Says "Medium — load-bearing happy-path change". Accurate. But Phase 5 also restructures the task-success handler in `events.ts` *and* changes a category set used by reporting (`POST_EXECUTION_PHASES`) which Phase 5's own doc warns may quietly change scheduler/TUI behaviour at three audited consumer sites. Consider raising to "Medium-High."

**[nit] README cross-phase conventions do not mention `inbox_items` as a cross-phase escalation contract.** Once Phase 1 step 1.6 lands, every "escalation that previously set `runStatus = 'failed'`" is supposed to write an inbox row. Phase 5 step 5.2's `rerouteToReplan` exhaustion path does not honour this implicit contract. README should call out "all post-Phase-1 escalation paths append an `inbox_items` row" as a cross-phase invariant.

---

## Summary by severity

- **Blocker:** Phase 1 vs Phase 5 events.ts edits step on each other (§1, §2); Phase 5 step 5.1 internal contradiction at L28 vs L33 (§4); README Phase 2 row is wrong (§6); `RebaseVerifyIssue.conflictedFiles` shape unspecified for two new emit sites (§3).
- **Serious:** Config field naming drift (`max_squash_retries` snake_case in a camelCase codebase) (§3); two retry abstractions without shared vocabulary (§3); Phase 5 exhaustion path bypasses Phase 1 inbox contract (§4); Phase 4 disposal vs Phase 5 transition ordering ambiguous "(or alongside)" (§4); shared integration test fixture coordination risk (§5); README Phase 4 row hides ship-order constraint (§6); Phase 5 squash-failure not enumerated in `IntegrationOutcome` (§3).
- **Nit:** Phase 3 swallow-vs-Phase-1 retry test coupling (§5); Phase 3 tick-counter holds open across Phase 5 retry loop awaits — note explicitly (§4); README ordering note buried in prose (§1); README cross-phase conventions missing the inbox invariant (§6).
