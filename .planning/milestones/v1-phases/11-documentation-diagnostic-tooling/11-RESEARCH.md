# Phase 11: Documentation & Diagnostic Tooling — Research

**Researched:** 2026-05-01
**Domain:** read-only `gvc0 explain` diagnostics, text-output reuse from existing TUI view models, and truthfulness limits on persisted run history
**Confidence:** HIGH (all findings verified from current repo code, tests, and planning artifacts; no external research required)

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-DOC-01 | Execution flow is documented end-to-end — one canonical flow diagram [VERIFIED: .planning/REQUIREMENTS.md] | The first Phase 11 slice should expose live execution flow state through a read-only CLI before later doc-consolidation work. Existing flow truth already lives in current graph/run/event seams, especially `snapshotGraph()`, `listAgentRuns()`, feature-phase completion events, and planner audit normalization [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/scheduler/events.ts] |
| REQ-DOC-02 | State shape is documented with one canonical three-axis diagram [VERIFIED: .planning/REQUIREMENTS.md] | `gvc0 explain` can make the shipped work × collab × run model directly inspectable by reusing canonical derived-state helpers such as `deriveTaskPresentationStatus(...)`, `deriveSummaryAvailability(...)`, and `deriveFeatureUnitStatus(...)` rather than restating the model in ad-hoc CLI logic [VERIFIED: src/core/state/index.ts][VERIFIED: docs/architecture/data-model.md] |
| REQ-DOC-03 | Coordination semantics are documented with decision tables, not prose [VERIFIED: .planning/REQUIREMENTS.md] | Current blockers, waits, retry windows, planner collisions, verification events, and merge-train parking already surface through run rows plus selected event types; the diagnostic CLI can expose those semantics directly and give the later docs pass a truth anchor [VERIFIED: docs/operations/verification-and-recovery.md][VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/orchestrator/features/index.ts][VERIFIED: src/orchestrator/scheduler/warnings.ts] |

## Locked Scope and Constraints

- 11-01 is the diagnostic CLI slice from Phase 11 success criterion 1, not the later doc-vs-code drift checker or concerns-to-tests map [VERIFIED: .planning/ROADMAP.md].
- The `explain` path should be read-only at the orchestrator level: it may open the existing project database and read graph/run/event state, but it must not start the TUI, scheduler, workers, or append new events/runs [VERIFIED: src/main.ts][VERIFIED: src/app/index.ts][VERIFIED: src/compose.ts].
- “Run history” must stay truthful to persisted evidence. The store has a current `agent_runs` row plus a narrower event trail, not a full event-sourced transition log for every run-state change [VERIFIED: src/core/types/events.ts][VERIFIED: src/orchestrator/scheduler/events.ts].
- Text output should reuse existing derived-state/view-model wording wherever possible so CLI output and TUI output cannot silently drift [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/core/state/index.ts].
- Doc-vs-code drift checks, canonical diagram updates, concern cross-linking, and newcomer narrative docs remain later Phase 11 slices [VERIFIED: .planning/ROADMAP.md].
</phase_requirements>

## Summary

11-01 does not need a second orchestrator mode, new persistence, or a new state model. The codebase already has the core pieces needed for a truthful read-only diagnostic CLI:

- a stable project-root bootstrap seam in `compose.ts` that resolves `.gvc0/state.db`
- canonical graph and run query surfaces on the Store (`snapshotGraph()`, `getAgentRun()`, `listAgentRuns()`, `listEvents()`)
- pure derived-state helpers for blocked/presentation state and feature aggregate state
- text-oriented TUI view-model builders that already summarize planner audit, proposal review, merge-train, and DAG node state
- normalized planner audit entries via `listPlannerAuditEntries(...)`

The main gap is CLI branching. `src/main.ts` currently only chooses `interactive` vs `auto`, and `GvcApplication.start()` always shows the TUI. That means `gvc0 explain ...` should branch before app startup instead of trying to force-fit a diagnostic path through `AppMode` and `ui.show()`.

The second major constraint is truthfulness: there is no exhaustive run-transition event log. A useful `explain run <id>` can still exist, but it must present:

- the current run row
- payload-derived blocker/wait information
- and recorded related events only

—not an invented full timeline that the store never persisted.

**Primary research conclusion:** the clean 11-01 shape is a pre-TUI `explain` CLI branch in `src/main.ts` backed by small read-only query helpers in `src/compose.ts`, with output built from existing `TuiViewModelBuilder` summaries and `@core/state` derivations. Reuse should happen at the text-summary layer, not by printing overlay chrome.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| CLI dispatch for `gvc0 explain` | `src/main.ts` | `src/app/index.ts` (negative constraint) | `main.ts` is the only current CLI parser, and `GvcApplication.start()` always calls `ui.show()`, so diagnostics should branch before app startup [VERIFIED: src/main.ts][VERIFIED: src/app/index.ts] |
| Project-state loading | `src/compose.ts` + Store | `src/persistence/db.ts` | `composeApplication()` already resolves `projectRoot`, config, `.gvc0/state.db`, `PersistentFeatureGraph`, and `SqliteStore`; a read-only helper can reuse that bootstrap shape without scheduler/UI wiring [VERIFIED: src/compose.ts][VERIFIED: src/persistence/db.ts] |
| Canonical status derivation | `src/core/state/index.ts` | `src/tui/view-model/index.ts` | The derived blocked/feature/summary semantics already live in pure helpers and should stay authoritative for CLI output [VERIFIED: src/core/state/index.ts] |
| Human-readable text summaries | `src/tui/view-model/index.ts` | `src/compose.ts` audit normalization | Planner audit, proposal review, merge-train, and DAG node summaries already exist in CLI-friendly strings or near-CLI-friendly view models [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/compose.ts] |
| Planner audit normalization | `src/compose.ts` | Store events | `listPlannerAuditEntries(...)` already turns raw top-planner events into structured entries filtered by feature scope [VERIFIED: src/compose.ts] |
| Recorded run activity | Store run row + selected events | Feature/planner event emitters | Current persisted truth is the run row plus selected events such as `feature_phase_completed`, `verifier_issue_raised`, `proposal_*`, `warning_emitted`, and merge-train parking [VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/agents/runtime.ts][VERIFIED: src/agents/tools/feature-phase-host.ts][VERIFIED: src/orchestrator/features/index.ts][VERIFIED: src/orchestrator/scheduler/warnings.ts] |

## Current Implementation Inventory

### 1. There is no current `explain` command path

`src/main.ts` currently does only three CLI things:

- applies `--cwd`
- writes `loading...`
- chooses `interactive` vs `auto` through `parseAppMode(...)`

No existing parser or entrypoint handles `explain`, and a repo-wide search found no existing diagnostic CLI surface under `src/` or `test/` [VERIFIED: src/main.ts][VERIFIED: test/unit/tui/main.test.ts].

### 2. The current app lifecycle is TUI-first

`GvcApplication.start()` always runs `await this.ports.ui.show()` before the lifecycle `start(...)` hook. That makes an `AppMode = 'explain'` extension awkward if it still flows through `GvcApplication` [VERIFIED: src/app/index.ts].

**Research implication:** 11-01 should branch in `main.ts` before calling `appFactory()`/`app.start(...)` whenever the command is `explain ...`.

### 3. The project-state bootstrap seam already exists

`composeApplication()` already resolves the exact project-local state needed by diagnostics:

- `projectRoot = process.cwd()`
- `configSource.load()`
- `openDatabase(path.join(projectRoot, '.gvc0', 'state.db'))`
- `PersistentFeatureGraph`
- `SqliteStore`

[VERIFIED: src/compose.ts][VERIFIED: src/persistence/db.ts]

The Store already exposes the read APIs needed by diagnostics:

- `getAgentRun(id)`
- `listAgentRuns(query?)`
- `listEvents(query?)`
- `snapshotGraph()`
- `rehydrate()`

[VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: test/unit/persistence/store-port.test.ts]

### 4. The TUI already contains reusable text-oriented derived state

The most reusable existing builders are:

- `buildMilestoneTree(...)` → DAG node labels, icons, work/collab status, and meta rows for milestones/features/tasks
- `buildPlannerAudit(...)` → human-readable planner audit item summaries
- `buildProposalReview(...)` → proposal-review summary lines plus collision rows
- `buildMergeTrain(...)` → merge-train queue summaries
- `buildComposer(...)` → current task wait/approval detail wording

[VERIFIED: src/tui/view-model/index.ts][VERIFIED: test/unit/tui/view-model.test.ts]

Important nuance: several of the most useful text helpers are currently private and wrapped in overlay-specific builders, for example `summarizePlannerAuditEntry(...)`, `summarizeProposalCollision(...)`, `formatProposalOpSummary(...)`, and `summarizeTaskWaitPayload(...)` [VERIFIED: src/tui/view-model/index.ts].

**Research implication:** 11-01 should reuse these lower-level text builders directly, or lift them into shared exports, rather than printing overlay titles like `[q/esc hide]` in CLI output.

### 5. Planner audit normalization is already solved below the TUI

`listPlannerAuditEntries(...)` in `src/compose.ts` already:

- reads top-planner events
- normalizes them through `readPlannerAuditEntry(...)`
- filters by touched feature when requested
- returns stable, timestamp-sorted `PlannerAuditEntry[]`

This is the right source for any feature-level audit section in `gvc0 explain feature <id>` [VERIFIED: src/compose.ts][VERIFIED: src/tui/app-deps.ts][VERIFIED: test/unit/compose.test.ts].

### 6. Run-history truth is bounded by current persistence

The Store’s event schema is intentionally generic:

```typescript
interface EventRecord {
  eventType: string;
  entityId: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}
```

[VERIFIED: src/core/types/events.ts]

Current emitted events include high-signal milestones such as:

- `top_planner_requested`, `top_planner_prompt_recorded`, `proposal_rerun_requested`, `proposal_applied`, `proposal_apply_failed`, `proposal_rejected`, `proposal_collision_resolved`
- `feature_phase_completed`
- `verifier_issue_raised`
- `warning_emitted`
- `merge_train_feature_parked`
- `commit_trailer_missing`
- `task_completion_rejected_no_commit`

[VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/agents/runtime.ts][VERIFIED: src/agents/tools/feature-phase-host.ts][VERIFIED: src/orchestrator/features/index.ts][VERIFIED: src/orchestrator/scheduler/warnings.ts]

But there is **not** a full event stream for every run-state transition like `running -> await_response -> checkpointed_await_response -> running` on a per-run basis [VERIFIED: src/orchestrator/scheduler/events.ts]. Many important wait/retry/manual-ownership facts live only on the current `agent_runs` row.

**Research implication:** 11-01 should label any history section as recorded activity / recorded events and compute it from the best available persisted evidence for the target run’s scope.

### 7. Docs drift is real, but belongs to 11-02

`docs/reference/tui.md` is visibly behind shipped Phase 8–10 behavior: it still lists older overlay surfaces and an older command set [VERIFIED: docs/reference/tui.md]. That validates the broader Phase 11 need, but the doc-vs-code reconciliation itself belongs to 11-02, not 11-01 [VERIFIED: .planning/ROADMAP.md].

## Gaps vs Roadmap

| Roadmap Success Criterion | Current State | Gap to Close |
|---------------------------|---------------|--------------|
| `gvc0 explain feature <id> / task <id> / run <id>` prints a human-readable state-at-a-glance | No `explain` entrypoint exists; current CLI always starts the TUI path [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/main.ts][VERIFIED: src/app/index.ts] | Add a pre-TUI CLI branch that opens project state and renders text output only |
| Output shows work × collab × run axes | Canonical semantics already exist in `@core/state` and the DAG view-model builder [VERIFIED: src/core/state/index.ts][VERIFIED: src/tui/view-model/index.ts] | Reuse those derived rules in CLI formatting instead of duplicating status logic |
| Output shows run history | Persisted truth is only the current run row plus selected events [VERIFIED: src/core/types/events.ts][VERIFIED: src/orchestrator/scheduler/events.ts] | Present recorded activity truthfully; do not overclaim a full timeline |
| Output shows current blockers | Current wait/approval/retry/manual state lives on the run row and some payload JSON; TUI already summarizes some of it [VERIFIED: src/orchestrator/ports/index.ts][VERIFIED: src/tui/view-model/index.ts] | Export or reuse the payload-summary helpers so explain output and TUI blocker wording stay aligned |

## Likely Risks

- **Trying to add `explain` as just another `AppMode`.** That would still flow through `ui.show()` unless `GvcApplication` is reworked, which is unnecessary for this slice [VERIFIED: src/main.ts][VERIFIED: src/app/index.ts].
- **Duplicating state derivation in new CLI-only formatters.** That would create immediate drift between TUI and CLI about blocked state, feature status, and summary availability [VERIFIED: src/core/state/index.ts][VERIFIED: src/tui/view-model/index.ts].
- **Printing overlay chrome as CLI output.** Existing overlay view models include titles like `[q/esc hide]`; the CLI should reuse the inner text summaries, not the presentation shell [VERIFIED: src/tui/view-model/index.ts].
- **Inventing a full run timeline.** The current persistence model cannot support that claim for most runs [VERIFIED: src/core/types/events.ts][VERIFIED: src/orchestrator/scheduler/events.ts].
- **Dumping raw payload JSON to compensate for missing summaries.** That would make output noisy and leak implementation detail instead of producing the promised human-readable state-at-a-glance [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/compose.ts].

## Relevant Existing Abstractions to Reuse

| Abstraction | Where | Why Reuse It |
|-------------|-------|--------------|
| `buildMilestoneTree(...)` + `DagNodeViewModel` | `src/tui/view-model/index.ts` [VERIFIED: src/tui/view-model/index.ts] | Already encodes the same feature/task status, icon, meta, dependency, and blocked/wait semantics that `explain feature` and `explain task` need |
| `deriveTaskPresentationStatus(...)`, `deriveSummaryAvailability(...)`, `deriveFeatureUnitStatus(...)` | `src/core/state/index.ts` [VERIFIED: src/core/state/index.ts] | Canonical pure state derivation; should stay the source of truth behind CLI summaries |
| `listPlannerAuditEntries(...)` | `src/compose.ts` [VERIFIED: src/compose.ts] | Already normalizes raw top-planner events into feature-filterable audit entries |
| `buildPlannerAudit(...)` | `src/tui/view-model/index.ts` [VERIFIED: src/tui/view-model/index.ts] | Already yields compact, human-readable planner audit rows suitable for CLI reuse |
| `buildProposalReview(...)` + `pendingProposalForSelection(...)` | `src/tui/view-model/index.ts`, `src/tui/app-state.ts` [VERIFIED: src/tui/view-model/index.ts][VERIFIED: src/tui/app-state.ts] | Can surface pending proposal/collision state in explain output without inventing a second proposal formatter |
| `buildMergeTrain(...)` | `src/tui/view-model/index.ts` [VERIFIED: src/tui/view-model/index.ts] | Existing merge-train summary wording can be reused when a feature is queued or integrating |
| `PlannerAuditEntry` | `src/tui/app-deps.ts` [VERIFIED: src/tui/app-deps.ts] | Stable normalized type already consumed by TUI and tests |

## Recommended Architecture Shape

### CLI branch first, then read-only query helpers

The cleanest 11-01 architecture is:

1. extend `src/main.ts` with explicit `explain` command parsing
2. branch before `appFactory()` / `app.start(...)`
3. call small read-only explain helpers that open the existing project state
4. render text and exit

This is simpler and safer than extending `AppMode` or changing `GvcApplication.start()` [VERIFIED: src/main.ts][VERIFIED: src/app/index.ts].

### Reuse TUI semantics at the text-summary layer

For output quality and drift resistance:

- reuse `buildMilestoneTree(...)` to derive feature/task rows
- reuse `buildPlannerAudit(...)` and `listPlannerAuditEntries(...)` for planner provenance sections
- reuse `buildProposalReview(...)` and `pendingProposalForSelection(...)` for pending-proposal/collision sections when relevant
- reuse or lift the private summary helpers for task wait payloads, planner audit rows, proposal collision rows, and proposal op summaries

The CLI should not print overlay titles or box chrome. It should print the underlying summaries that those builders already generate [VERIFIED: src/tui/view-model/index.ts].

### Label run history as recorded activity

The best truthful shape for `gvc0 explain run <id>` is:

- current run identity (`scopeType`, `scopeId`, `phase`)
- current run state (`runStatus`, `owner`, `attention`, `sessionId`, retries)
- current blocker summary derived from payload/wait state
- recorded activity entries sourced from related events only

That satisfies the roadmap intent without overstating current persistence [VERIFIED: .planning/ROADMAP.md][VERIFIED: src/core/types/events.ts][VERIFIED: src/orchestrator/scheduler/events.ts].

## Concrete File and Test Targets

### Primary implementation files

| File | Why it matters | Likely 11-01 use |
|------|----------------|------------------|
| `src/main.ts` | Current CLI parsing and startup dispatch [VERIFIED: src/main.ts] | Add `explain` parsing and branch before TUI startup |
| `src/compose.ts` | Current project bootstrap and planner audit normalization [VERIFIED: src/compose.ts] | Add small read-only explain helpers that open the existing project state and return text/sections |
| `src/tui/view-model/index.ts` | Existing text summaries and DAG builders [VERIFIED: src/tui/view-model/index.ts] | Export/lift lower-level summary helpers or add a CLI-friendly builder that reuses current semantics |
| `src/tui/app-state.ts` | Pending proposal derivation [VERIFIED: src/tui/app-state.ts] | Reuse for optional feature explain sections about pending proposals/collisions without duplicating logic |
| `src/core/state/index.ts` | Canonical derived-state rules [VERIFIED: src/core/state/index.ts] | Reuse directly for explain formatting; avoid parallel logic |
| `src/orchestrator/ports/index.ts` | Store read API contracts [VERIFIED: src/orchestrator/ports/index.ts] | Query runs/events/snapshot state for explain surfaces |

### Existing tests to extend first

| Test file | Existing coverage | Likely 11-01 extension |
|-----------|-------------------|------------------------|
| `test/unit/tui/main.test.ts` | CLI startup notice, `--cwd`, `parseAppMode(...)`, startup error handling [VERIFIED: test/unit/tui/main.test.ts] | Add `explain` parsing/routing tests and prove the explain path does not start the TUI app |
| `test/unit/compose.test.ts` | Planner audit normalization and compose helper tests [VERIFIED: test/unit/compose.test.ts] | Add explain-helper tests over in-memory state and related-event summaries |
| `test/unit/tui/view-model.test.ts` | Planner audit/proposal/collision/session builder tests [VERIFIED: test/unit/tui/view-model.test.ts] | Add coverage for any newly exported CLI-friendly summary helpers and DAG-node selection for explain output |
| `test/unit/persistence/store-port.test.ts` | Snapshot/rehydrate/store contract tests [VERIFIED: test/unit/persistence/store-port.test.ts] | No required changes, but it confirms the read-only query assumptions behind explain state loading |

## Common Pitfalls

### Pitfall 1: extending `AppMode` instead of branching before startup
**What goes wrong:** `gvc0 explain` still triggers `ui.show()` or forces invasive lifecycle changes.
**Why it happens:** `GvcApplication.start()` is currently TUI-first.
**How to avoid:** parse `explain` at the CLI layer and run diagnostics without calling `app.start(...)` [VERIFIED: src/main.ts][VERIFIED: src/app/index.ts].

### Pitfall 2: copying TUI status logic into CLI-only formatters
**What goes wrong:** CLI and TUI disagree on blocked status, feature state, or summary availability.
**Why it happens:** the explain path re-implements rules already covered by `@core/state` and `TuiViewModelBuilder`.
**How to avoid:** build output from the current derivation helpers and existing view-model builders [VERIFIED: src/core/state/index.ts][VERIFIED: src/tui/view-model/index.ts].

### Pitfall 3: overclaiming run history
**What goes wrong:** output implies the system has a complete timeline when it only has the current run row plus selected events.
**Why it happens:** roadmap wording is interpreted too literally against thinner persistence.
**How to avoid:** name the section `recorded activity` or equivalent and restrict it to persisted evidence [VERIFIED: src/core/types/events.ts][VERIFIED: src/orchestrator/scheduler/events.ts].

### Pitfall 4: reusing overlay shells instead of reusable summaries
**What goes wrong:** CLI output includes `[q/esc hide]`, overlay titles, or other TUI chrome.
**Why it happens:** the explain path prints overlay view models directly.
**How to avoid:** reuse the lower-level summary functions/items/lines rather than the full overlay framing [VERIFIED: src/tui/view-model/index.ts].

## Validation Architecture

### Focused verification

- `npm run typecheck`
- `npx vitest run test/unit/tui/main.test.ts`
- `npx vitest run test/unit/compose.test.ts`
- `npx vitest run test/unit/tui/view-model.test.ts`

### What to prove

| Behavior | Test surface | Why |
|----------|--------------|-----|
| `gvc0 explain ...` bypasses TUI startup | `test/unit/tui/main.test.ts` | Prevents accidental coupling to `ui.show()` |
| feature/task explain output reuses canonical derived status rules | `test/unit/compose.test.ts` and/or `test/unit/tui/view-model.test.ts` | Keeps CLI/TUI semantics aligned |
| run explain output presents only recorded activity | `test/unit/compose.test.ts` | Guards against overclaiming a full run timeline |
| planner audit/proposal summary wording stays shared | `test/unit/compose.test.ts` + `test/unit/tui/view-model.test.ts` | Reinforces the “view-model reuse for text output” promise |

## Sources

### Primary (HIGH confidence)
- `.planning/ROADMAP.md` — Phase 11 goal, 11-01 slice name, and success criteria [VERIFIED: .planning/ROADMAP.md]
- `.planning/REQUIREMENTS.md` — REQ-DOC-01/02/03 [VERIFIED: .planning/REQUIREMENTS.md]
- `.planning/STATE.md` — current milestone handoff and phase position [VERIFIED: .planning/STATE.md]
- `src/main.ts` — current CLI parser/startup path [VERIFIED: src/main.ts]
- `src/app/index.ts` — unconditional `ui.show()` startup behavior [VERIFIED: src/app/index.ts]
- `src/compose.ts` — project bootstrap and planner audit normalization [VERIFIED: src/compose.ts]
- `src/persistence/db.ts` — DB open/migration helper [VERIFIED: src/persistence/db.ts]
- `src/orchestrator/ports/index.ts` — Store query API [VERIFIED: src/orchestrator/ports/index.ts]
- `src/core/state/index.ts` — canonical derived state helpers [VERIFIED: src/core/state/index.ts]
- `src/core/types/events.ts` — event schema limits [VERIFIED: src/core/types/events.ts]
- `src/tui/app-deps.ts` — normalized planner audit entry type [VERIFIED: src/tui/app-deps.ts]
- `src/tui/app-state.ts` — pending proposal derivation [VERIFIED: src/tui/app-state.ts]
- `src/tui/view-model/index.ts` — reusable text summaries and DAG builders [VERIFIED: src/tui/view-model/index.ts]
- `src/orchestrator/scheduler/events.ts` — current event emitters and run-state persistence behavior [VERIFIED: src/orchestrator/scheduler/events.ts]
- `src/orchestrator/features/index.ts` — merge-train parking events [VERIFIED: src/orchestrator/features/index.ts]
- `src/orchestrator/scheduler/warnings.ts` — warning events [VERIFIED: src/orchestrator/scheduler/warnings.ts]
- `src/agents/runtime.ts` — feature-phase completion event emission [VERIFIED: src/agents/runtime.ts]
- `src/agents/tools/feature-phase-host.ts` — verifier issue event emission [VERIFIED: src/agents/tools/feature-phase-host.ts]
- `docs/architecture/data-model.md` — canonical three-axis model [VERIFIED: docs/architecture/data-model.md]
- `docs/operations/verification-and-recovery.md` — current coordination/wait/retry semantics [VERIFIED: docs/operations/verification-and-recovery.md]
- `docs/reference/tui.md` — evidence of doc drift and current CLI docs gap [VERIFIED: docs/reference/tui.md]
- `test/unit/tui/main.test.ts` — current CLI test surface [VERIFIED: test/unit/tui/main.test.ts]
- `test/unit/compose.test.ts` — current compose helper and audit normalization tests [VERIFIED: test/unit/compose.test.ts]
- `test/unit/tui/view-model.test.ts` — current summary-builder tests [VERIFIED: test/unit/tui/view-model.test.ts]
- `test/unit/persistence/store-port.test.ts` — snapshot/rehydrate/store contract tests [VERIFIED: test/unit/persistence/store-port.test.ts]

### Secondary (MEDIUM confidence)
- None — all relevant findings came from the current repo.

### Tertiary (LOW confidence)
- Exact final CLI text layout is still a planning/implementation discretion point as long as it stays grounded in the shared view-model/state helpers [ASSUMED].

## Metadata

**Confidence breakdown:**
- CLI entrypoint gap: HIGH
- read-only bootstrap seam: HIGH
- shared state/view-model reuse seam: HIGH
- planner audit/proposal reuse seam: HIGH
- run-history truthfulness limit: HIGH
- later doc-drift follow-up separation: HIGH

**Research date:** 2026-05-01
**Valid until:** 11-01 implementation begins; if the CLI/app startup path changes first, re-check `src/main.ts`, `src/app/index.ts`, and `src/compose.ts` before coding
