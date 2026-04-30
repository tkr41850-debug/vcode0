# 01-baseline — MVP hardening

Baseline implementation work to bring `main` to a shippable single-orchestrator MVP, derived from a comparison with the `gsd` branch — a parallel implementation track of this same project that used the GSD planning methodology to continue work, while `main` did not. The phases below port back the architectural advances that proved out on `gsd`, scoped to the minimum needed for a shippable MVP.

Note: this is unrelated to `docs/compare/`, which catalogues external systems and prior art.

## Scope

Five phases. **Phase 5 is foundational and must ship first** — without it, the orchestrator does not actually land task work on the feature branch end-to-end (verified by tracing `submit` → `events.ts` → `integration/index.ts` on `main`; the eventual feature-into-main merge integrates an empty feature branch). Phases 1–4 are defensive hardening that presume the happy path works.

Recommended ship order: **5 → 1 → 2 → 3 → 4**. Phase 5 is foundational (without it, no task work reaches the feature branch). Phase 4 task-worktree disposal also depends on Phase 5's squash hook.

| Phase | Theme | Items | Risk |
|-------|-------|-------|------|
| [Phase 5](./phase-5-task-integration.md) | **Task → feature integration (foundational)** — ships first | Squash-merge task branch into feature on submit, conflict retry, `awaiting_merge` data-model fix | Medium — load-bearing happy-path change; touches three `featurePhaseCategory` consumers |
| [Phase 1](./phase-1-safety.md) | Safety & survivability | IPC schema validation, heartbeat, retry policy, destructive-op guard, inbox/quarantine tables | Medium — touches worker hot path |
| [Phase 2](./phase-2-merge-train.md) | Merge-train race safety | Plumbing-based atomic CAS on `refs/heads/main` (`merge-tree --write-tree` + `commit-tree` + `update-ref`) | Medium — replaces working-tree merge with plumbing; ~40-50 lines, CAS-failure stderr detection, reroute path; optional unless multi-orchestrator |
| [Phase 3](./phase-3-scheduler.md) | Scheduler hardening | Tick-boundary mutation guard, dispatch-time unmerged-dep belt-and-suspenders | Low — env-gated assert + defensive guard |
| [Phase 4](./phase-4-recovery.md) | Recovery depth | Worktree disposal at task-squash and feature-merge points + stale-lock sweep (depends on Phase 5 for the task-squash hook) | Low — additive lifecycle methods |

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

- New persistence work uses the existing TS migration system (`src/persistence/migrations/NNN_*.ts`). Migration filenames continue the existing numbering — do not switch to the SQL-file runner from `gsd` in this baseline.
- New IPC frame variants extend `WorkerToOrchestratorMessage` / `OrchestratorToWorkerMessage` in `src/runtime/contracts.ts`. Schema-validation gate is added in Phase 1 step 1.
- New Store methods extend the `Store` port in `src/orchestrator/ports/index.ts` first, then `SqliteStore`.
- All new code respects the architecture boundary: `core/` does not import `runtime/` or `persistence/`.
- **Inbox-row invariant**: every escalation path appends an `inbox_items` row (Phase 1 step 1.6). `kind` is a TS string-literal union: `semantic_failure | retry_exhausted | destructive_action | squash_retry_exhausted`. Phase 5's squash exhaustion (step 5.2) and Phase 1's destructive-op guard (step 1.7) are both inbox producers; do not introduce a new escalation that bypasses the inbox.
- **Retry vocabulary boundary**: Phase 1's `RetryPolicy` (worker-error retries: network/429/5xx/`health_timeout`, exponential backoff with jitter) and Phase 5's `maxSquashRetries` (deterministic git-conflict retries inside one tick: `rebase → squash`, no jitter) are sibling abstractions. Do not collapse one into the other.
- **VerifyIssue source disambiguation**: `VerifyIssueSource` (`src/core/types/verification.ts:48`) covers `'verify' | 'ci_check' | 'rebase' | 'squash'` after Phase 5. Phase 2's `main_moved` reroute uses `'rebase'` (concurrency loss); Phase 5's squash exhaustion uses `'squash'` (inherent conflict). Operators disambiguate at planner intake by `source`.
- **Multi-phase test fixtures**: `test/integration/feature-phase-agent-flow.test.ts` is touched by Phases 1, 3, and 5 — coordinate edits so commit ordering is clean. Phase 5 verifies `workControl: 'awaiting_merge' → 'work_complete'` (lines 730, 759 today) is unaffected by the squash insertion. Other phases append assertions rather than reshape existing ones.

## Out of scope

- Repair-loop bundle (`executing_repair` workControl, `enqueueRepairTask`, verify-issue flattening).
- Migration system overhaul (TS → SQL-file runner).
- TUI live-planner removal or replacement.
- AST boundary walker test, JSDoc planner-prompt input contract, exhaustive-event `: never` trailer (devex polish).
- Live-planner third dataMode is **kept** — main is ahead of `gsd` here.
