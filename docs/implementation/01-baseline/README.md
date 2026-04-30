# 01-baseline — MVP hardening

Baseline implementation work to bring `main` to a shippable single-orchestrator MVP, derived from a comparison with the `gsd` branch — a parallel implementation track of this same project that used the GSD planning methodology to continue work, while `main` did not. The phases below port back the architectural advances that proved out on `gsd`, scoped to the minimum needed for a shippable MVP.

Note: this is unrelated to `docs/compare/`, which catalogues external systems and prior art.

## Scope

Nine phases. Two are load-bearing for end-to-end correctness: **Phase 8** unblocks `/init` + `/auto` (planning currently bounces into `retry_await`), and **Phase 5** wires the missing task→feature squash that today leaves the merge train integrating empty feature branches. Phases 6 and 7 are cleanup (config + TUI), phases 1–4 are defensive hardening that presume the happy path works, and **Phase 9** is a producer-only debugging aid (first-failure stack dumps under `.gvc0/logs/`).

Recommended ship order: **8 → 5 → 6 → 7 → 1 → 9 → 2 → 3 → 4**.

- **Phase 8 first**: small, contained fix for a user-visible regression (planning dispatch tries to provision a feature worktree before a feature branch even exists). Step 8.2 establishes `ensureFeatureBranch` on the `WorktreeProvisioner` interface — downstream test doubles get a stable shape from this point forward.
- **Phase 5 second**: foundational happy-path work. Without it, no task commit ever reaches the feature branch. Phase 4 task-worktree disposal also depends on Phase 5's squash hook.
- **Phase 6 third**: centralizes config defaults so the later phases that read or extend config-adjacent values pull from one source of truth.
- **Phase 7 fourth**: TUI composer/autocomplete stability. Independent of correctness phases, but ship it before phases 1–4 so the operator UX is comfortable during interactive testing of the heavier-risk work.
- **Phase 1 before Phase 9**: Phase 9's error-log hook lives at the same retry-decision sites that Phase 1 step 1.5 unifies. Shipping 9 after 1 means the call sites are stable. Phase 9 is otherwise independent of 2–4.
- **Phases 2–4 last**: merge-train CAS, scheduler hardening, recovery. Each consumes invariants established by 5 and 8.

| Phase | Theme | Items | Risk |
|-------|-------|-------|------|
| [Phase 8](./phase-8-planning-branch-bootstrap.md) | **Planning dispatch & feature-branch bootstrap** — ships first | Skip feature worktree for `discuss\|research\|plan\|replan`; explicit `ensureFeatureBranch` before `branch_open` | Low — narrow gate + additive provisioner method |
| [Phase 5](./phase-5-task-integration.md) | **Task → feature integration (foundational)** — ships second | Squash-merge task branch into feature on submit, conflict retry, `awaiting_merge` data-model fix | Medium — load-bearing happy-path change; touches three `featurePhaseCategory` consumers |
| [Phase 6](./phase-6-config-defaults.md) | Config defaults & generation | Centralize default ownership in `src/config.ts`, route consumers through helpers, drive sparse first-run generation from same source | Low — cleanup with behavioral guardrails; preserves sparse-config semantics |
| [Phase 7](./phase-7-composer-focus-and-autocomplete.md) | TUI composer focus & autocomplete | Stable autocomplete provider that survives refresh; `esc` always defocuses composer | Low — UI wiring, no `pi-tui` patching |
| [Phase 1](./phase-1-safety.md) | Safety & survivability | IPC schema validation, heartbeat, retry policy, destructive-op guard, inbox/quarantine tables | Medium — touches worker hot path |
| [Phase 2](./phase-2-merge-train.md) | Merge-train race safety | Plumbing-based atomic CAS on `refs/heads/main` (`merge-tree --write-tree` + `commit-tree` + `update-ref`) | Medium — replaces working-tree merge with plumbing; ~40-50 lines, CAS-failure stderr detection, reroute path; optional unless multi-orchestrator |
| [Phase 3](./phase-3-scheduler.md) | Scheduler hardening | Tick-boundary mutation guard, dispatch-time unmerged-dep belt-and-suspenders | Low — env-gated assert + defensive guard |
| [Phase 4](./phase-4-recovery.md) | Recovery depth | Worktree disposal at task-squash and feature-merge points + stale-lock sweep (depends on Phase 5 for the task-squash hook) | Low — additive lifecycle methods |
| [Phase 9](./phase-9-retry-error-logs.md) | First-failure error logs on retry | Carry stack on worker error frame; `RunErrorLogSink` port; hook at `events.ts` retry-decision sites; one `.gvc0/logs/*.txt` per first failure | Low — debugging aid only, no scheduler/retry/persistence semantics change |

Items dropped from MVP because main already has them or has no consumer:

- Worker PID registry — already wired (`worker_pid` column + `killStaleWorkerIfNeeded`)
- Resume facade — `SessionCheckpoint.completedToolResults` + `agent.continue()` already implemented
- Commit-trailer injection + `last_commit_sha` — current reconciler attributes via branch + parent SHA, no consumer for trailers
- `executing_repair` priority arm — `FeatureWorkControl` union does not include `executing_repair` on main

## Working agreement

Each phase document lists numbered **steps**. Per step:

1. Implement.
2. Run `npm run check:fix` then `npm run check` until green (format, lint, typecheck, tests).
3. Run a review subagent with the prompt provided in the step (use `Agent` tool with `subagent_type: Explore`, model `sonnet` — verifies the change is real, complete, and free of obvious bugs).
4. Address review findings. Re-run `npm run check`.
5. Commit using the conventional-commit subject given in the step.

Phases that fit one logical change ship as one commit. Phases with several independent steps ship as multiple commits, one per step. No squashing across phases.

## Cross-phase conventions

- New persistence work uses the existing TS migration system (`src/persistence/migrations/NNN_*.ts`). The pre-0.0.0 Phase 0 reset wipes existing migrations and the chain restarts; baseline phases ship schemas with full constraints (e.g. permissive CHECK unions) up-front rather than chaining widening migrations. Do not switch to the SQL-file runner from `gsd` in this baseline.
- New IPC frame variants extend `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage` in `src/runtime/contracts.ts`. Schema-validation gate is added in Phase 1 step 1.
- New Store methods extend the `Store` port in `src/orchestrator/ports/index.ts` first, then `SqliteStore`.
- All new code respects the architecture boundary: `core/` does not import `runtime/` or `persistence/`.
- **Inbox-row invariant**: every escalation path appends an `inbox_items` row (Phase 1 step 1.6). `kind` is a TS string-literal union: `semantic_failure | retry_exhausted | destructive_action | squash_retry_exhausted`. Phase 5's squash exhaustion (step 5.2) and Phase 1's destructive-op guard (step 1.7) are both inbox producers; do not introduce a new escalation that bypasses the inbox.
- **Retry vocabulary boundary**: Phase 1's `RetryPolicy` (worker-error retries: network/429/5xx/`health_timeout`, exponential backoff with jitter) and Phase 5's `maxSquashRetries` (deterministic git-conflict retries inside one tick: `rebase → squash`, no jitter) are sibling abstractions. Do not collapse one into the other.
- **VerifyIssue source disambiguation**: `VerifyIssueSource` (`src/core/types/verification.ts:48`) covers `'verify' | 'ci_check' | 'rebase' | 'squash'` after Phase 5. Phase 2's `main_moved` reroute uses `'rebase'` (concurrency loss); Phase 5's squash exhaustion uses `'squash'` (inherent conflict). Operators disambiguate at planner intake by `source`.
- **Multi-phase test fixtures**: `test/integration/feature-phase-agent-flow.test.ts` is touched by Phases 1, 3, and 5 — coordinate edits so commit ordering is clean. Phase 5 verifies `workControl: 'awaiting_merge' → 'work_complete'` (lines 730, 759 today) is unaffected by the squash insertion. Other phases append assertions rather than reshape existing ones.
- **Multi-phase composition file**: `src/compose.ts` is touched by Phases 1 (quarantine ring construction), 6 (centralized config helpers + default model), 8 (`FeatureLifecycleCoordinator` wiring around `approveFeatureProposal`), and 9 (`runErrorLogSink` port construction). Each phase's edit is additive but lands in adjacent regions. Resolve merge conflicts by re-reading the file at edit time rather than relying on cached line ranges; line numbers cited in any single phase doc anchor today's `main`, not the post-Phase-8 / post-Phase-6 state.
- **Debugging-artifact directory**: Phase 9 introduces `<projectRoot>/.gvc0/logs/` for first-failure stack dumps via the new `RunErrorLogSink` port. The directory is debug-only — orchestrator state is unaffected by `rm -rf .gvc0/logs/`. Future phases that want a similar artifact (e.g. crash autopsies, flaky-test logs) should reuse the port pattern rather than write directly to disk from `core/`.

## Out of scope

- Repair-loop bundle (`executing_repair` workControl, `enqueueRepairTask`, verify-issue flattening).
- Migration system overhaul (TS → SQL-file runner).
- TUI live-planner removal or replacement.
- AST boundary walker test, JSDoc planner-prompt input contract, exhaustive-event `: never` trailer (devex polish).
- Live-planner third dataMode is **kept** — main is ahead of `gsd` here.
