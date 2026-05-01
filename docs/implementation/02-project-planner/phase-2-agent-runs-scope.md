# Phase 2 — `scope_type='project'` discriminator

Status: drafting
Verified state: as of a5abfeae9b1e59ee53d8c850da7203fdc146521a on 2026-05-01
Depends on: none
Default verify: npm run check:fix && npm run check
Phase exit: `npm run verify`; project-scope `AgentRun` insert + `SqliteStore` roundtrip; `listProjectSessions` queryable for the future `phase-6-tui-mode` session view; explicit `scopeType='project'` handling across orchestrator/runtime/tui without creating project runs yet
Doc-sweep deferred: none

## Contract

Goal: Extend the existing `agent_runs.scope_type` discriminator to recognize `'project'` alongside the current `'task'` and `'feature_phase'` values. Update the typed `AgentRun` union, codecs, and query helpers so the persistence layer can store and retrieve project-scope runs. No new dispatch path or agent code in this phase — that lands in `phase-4-project-planner-agent`.

Scope:
- In:
  - extend the `AgentRun` discriminated union in `src/core/types/runs.ts` with a third arm for `scope_type='project'`
  - update codec encode/decode paths in `src/persistence/codecs.ts` and the query helper in `src/persistence/queries/index.ts`
  - extend `Store` query methods with project-scope filters
  - add a stable singleton `scope_id` convention for project runs
- Out:
  - new dispatch path or scheduler integration (`phase-4-project-planner-agent`)
  - new agent role or prompts (`phase-4-project-planner-agent`)
  - TUI rendering (`phase-6-tui-mode`)
  - migration with CHECK constraint (deferred — column is `TEXT NOT NULL` with no constraint today, the union extension is type-only at the application level)

Exit criteria:
- All three commits land in order.
- `npm run verify` passes.
- A project-scope `AgentRun` can be inserted and round-tripped through `SqliteStore`.
- `listProjectSessions` returns the session list a future TUI session view will consume (`phase-6-tui-mode`).
- Every `scopeType` branch in orchestrator/runtime/tui handles the project arm explicitly (no silent fallthrough); production code paths still do not create project runs — that lands in `phase-4-project-planner-agent`.
- Run a final review subagent across the three commits to confirm the union extension is sound, the Store surface is minimal, no migration is needed, and exhaustiveness holds.

## Plan

Background:
- `agent_runs` table created in `src/persistence/migrations/001_init.ts:61-76` with `scope_type TEXT NOT NULL` and `scope_id TEXT NOT NULL`. No CHECK constraint on `scope_type`.
- Two values in current code: `'task'` and `'feature_phase'`. References at:
  - `src/core/types/runs.ts:49,54` — discriminated `AgentRun` union arms.
  - `src/persistence/queries/index.ts:124,129` — row-shape literal types.
  - `src/persistence/codecs.ts:290,317` — encode/decode discriminator branches.
  - `src/persistence/sqlite-store.ts:36,71,148,281` — column list, row shape, INSERT, query filter.
  - `src/core/scheduling/index.ts:61,468` — `SchedulableUnit.kind` (separate from `scope_type` but related vocabulary).
- `scope_id` is interpreted per `scope_type`: task id (`t-...`) or feature id (`f-...`) today.
- For project scope, only one project exists per orchestrator instance. The `scope_id` can be a stable singleton (for example `'project'`) — multiple sessions are distinguished by the `id` column, session resume queries by `id`, and session-list queries by `scope_type='project'`.

Notes:
- No migration. `scope_type` is `TEXT NOT NULL` with no CHECK; existing rows continue to deserialize cleanly. If a CHECK constraint is wanted later for type-safety, that is a separate `NNN_*.ts` migration outside this track.
- Scope id convention. Project `scope_id` is the singleton string `'project'` (typed const). The `id` column carries the per-session uid. This matches the existing pattern where `scope_id` identifies the target of the scope (a task, a feature, or the project itself) and `id` identifies the run instance.
- Forward compatibility. If a future change introduces multiple projects per orchestrator instance, `scope_id` widens to include a project uid; the typed union absorbs the change cleanly.
- `RunScope` deferral. `src/runtime/contracts.ts` `RunScope` and `src/runtime/worker-pool.ts` dispatch typing are not in Step 2.3's sweep — `phase-4-project-planner-agent` step 4.2 owns extending those. Step 2.3 audits them only to confirm "no creation site exists yet, so no project-scope `RunScope` value can flow through" — which is true on `main`.

## Steps

Ships as 3 commits, in order. Step 2.3 sweeps non-persistence call sites that pattern-match on `scopeType` so the new arm is handled exhaustively before any code path actually creates project runs.

---

### Step 2.1 — Extend `AgentRun` union and codecs [risk: low, size: M]

Approach: TDD where deterministic; type-only changes go alongside.

What: add a third arm to the `AgentRun` discriminated union for `scope_type='project'`. Update encode/decode paths to handle it. The arm should require `scopeId: 'project'` (or a typed singleton const) so the type system enforces the convention. The union arm itself is type-only (compiles or doesn't); the codec roundtrip and unknown-`scope_type` throw are TDD-applicable.

Test files (write first):
- `test/unit/persistence/codecs.test.ts` — add roundtrip coverage for a project-scope run; add a decode test asserting an unknown `scope_type` value throws.
- `test/unit/persistence/sqlite-store.test.ts` — add insert + list-by-scope coverage for project runs.

Prod files:
- `src/core/types/runs.ts` — add `ProjectAgentRun` arm with `scopeType: 'project'` and `scopeId: ProjectScopeId`. Define and export `ProjectScopeId = 'project'` as a typed singleton const so `phase-4-project-planner-agent` and any future consumer import the same name. The `phase-4-project-planner-agent` coordinator uses this const when creating the `agent_runs` row.
- `src/persistence/queries/index.ts` — add `scope_type: 'project'` row-shape arm.
- `src/persistence/codecs.ts` — extend `agentRunToRow` and `rowToAgentRun` discriminator branches to handle the project arm. Today's `rowToAgentRun` only special-cases `'task'` and falls through to `'feature_phase'` for anything else (no throw). Decision: add explicit `'task' | 'feature_phase' | 'project'` branches and throw on truly unknown values. The fallthrough was tolerable when the union had two arms and the rare edge case was a typo; it is unsafe with three arms because a corrupted `'project'` row could decode as `'feature_phase'` and miscategorize. Throwing forces every future `scope_type` addition to land an explicit branch here.
- `src/persistence/sqlite-store.ts` — verify `scope_type` filter passes through. The Store API is `listAgentRuns(...)` (not `listRuns`); `listAgentRuns({ scopeType: 'project' })` should return project rows.

Tests (write first, expect red):
- Codec roundtrip: encode `{ scopeType: 'project', scopeId: 'project', id: 'proj-...', phase: 'plan', runStatus: 'running' }` → row → decode produces equal value.
- SqliteStore insert + `listAgentRuns({ scopeType: 'project' })` returns the inserted row.
- Decoding a row with an unknown `scope_type` value throws (per the policy decision above).

Red → green workflow:
1. Land the type arm in `runs.ts` and `queries/index.ts` first so the test file compiles.
2. Write the three failing tests above against the unchanged codec/store. Run `npm run test:unit` — confirm RED (codec roundtrip fails on the project arm; unknown-`scope_type` test fails because today's decoder silently returns `'feature_phase'`).
3. Implement minimum code in `src/persistence/codecs.ts` (and the `sqlite-store.ts` filter pass-through if needed) to satisfy each test. Re-run `npm run test:unit` — confirm GREEN.
4. Refactor for clarity if needed; tests stay green.

Verification: `npm run check:fix && npm run check`.

Review goals:
1. Verify `src/core/types/runs.ts` has a third `AgentRun` arm with `scopeType: 'project'`.
2. Verify codecs roundtrip the new arm without data loss.
3. Verify `listAgentRuns` can filter by `scopeType: 'project'`.
4. Verify the decoder branches explicitly on `'task'`, `'feature_phase'`, and `'project'`, and throws on unknown `scope_type`.
5. Verify existing task and feature_phase paths are byte-for-byte unchanged in serialized form.
6. Treat the Step 2.3 cross-codebase exhaustiveness sweep as out of scope for this review.
7. Keep the review under 300 words.

Commit: `feat(persistence/agent-runs): extend scope_type with project arm`

---

### Step 2.2 — Project-run query helpers and Store port [risk: low, size: S]

Approach: TDD (test-first, red-green-refactor)

What: add typed query helpers for project-scope runs to the `Store` port and its SQLite implementation. The helpers serve two consumers: (a) the recovery service's boot-time rehydrate sweep (`phase-4-project-planner-agent` step 4.3), which queries `running` rows; (b) the TUI session-list view (`phase-6-tui-mode`), which queries any combination of statuses for resume / history. The helpers are not consumed by `prioritizeReadyWork` — project-run dispatch is event-driven from the coordinator and recovery service (see `phase-4-project-planner-agent` Background, "Dispatch model").

Test files (write first):
- `test/unit/persistence/sqlite-store.test.ts` — add implementation coverage. (No dedicated `test/unit/orchestrator/ports.test.ts` exists today; either extend `sqlite-store.test.ts` or add a new contract-test file alongside it — pick whichever matches the convention used for `getAgentRun` coverage.)

Prod files:
- `src/orchestrator/ports/index.ts` — extend the existing `AgentRunQuery` shape (today's `runStatus?: AgentRunStatus`, singular) with an optional `runStatuses?: AgentRunStatus[]` array filter — single canonical query API, both feature-phase and project consumers benefit. Add `listProjectSessions(filter?: { runStatuses?: AgentRunStatus[] })` as a thin wrapper over `listAgentRuns({ scopeType: 'project', runStatuses: filter?.runStatuses })`. Add `getProjectSession(id: string): AgentRun | undefined`. (No parallel codepath; the wrapper exists for type-narrowing readability and so callers don't have to repeat the `scopeType: 'project'` literal.)
- `src/persistence/sqlite-store.ts` — implement the new methods on `SqliteStore`. Match the existing convention where read methods return `undefined` (not `null`) when the row is missing, for example `getAgentRun(id): AgentRun | undefined`.

Tests (write first, expect red):
- `listProjectSessions` with no filter returns all rows where `scope_type='project'`.
- `listProjectSessions({ runStatuses: ['running', 'await_response'] })` returns only active sessions (using existing union members — no new statuses).
- `listAgentRuns({ runStatuses: ['running', 'await_response'] })` (the underlying query) returns rows whose status is in the array — confirms the new array filter applies generically.
- `getProjectSession` returns the row or `undefined`.
- Existing run-query tests stay green.

Red → green workflow:
1. Add the new method signatures to the `Store` port (compile-only stub) so the test file resolves. Adding `listProjectSessions` / `getProjectSession` and the `runStatuses?` field on `AgentRunQuery` to the port will compile-RED every existing `implements Store` site — at minimum `test/integration/harness/store-memory.ts`'s `InMemoryStore`. Add stub implementations on those mocks (return `[]` / `undefined` / pass-through) so the suite compiles before behavioral tests run. Treat this stub sweep as part of Step 2.2's scope, not separate plumbing.
2. Write failing tests asserting the four behaviors above. Run `npm run test:unit` — confirm RED (methods unimplemented or array filter not respected).
3. Implement the SQL filter (`scope_type='project'` + `IN (...)` for `runStatuses`) and the wrapper methods in `src/persistence/sqlite-store.ts`. Re-run `npm run test:unit` — confirm GREEN.
4. Refactor: ensure no duplication between `listAgentRuns` and the wrapper.

Verification: `npm run check:fix && npm run check`.

Review goals:
1. Verify the `Store` port has `listProjectSessions` and `getProjectSession` typed against the new union arm.
2. Verify the `SqliteStore` implementation filters correctly by `scope_type='project'` and optional status.
3. Verify existing run queries are unchanged.
4. Verify no leakage of project-scope concepts into task or feature_phase code paths.
5. Keep the review under 250 words.

Commit: `feat(orchestrator/store): add project-session query helpers`

---

### Step 2.3 — Exhaust `scopeType` switches across the codebase [risk: low, size: M]

Approach: TDD where deterministic; type-only changes go alongside.

What: every non-persistence call site that today pattern-matches on `scopeType` assumes a 2-arm union. Each must either handle the project arm explicitly or document an intentional ignore. No production path creates project runs yet (`phase-4-project-planner-agent` owns that), but this step prevents type errors and silent miscategorization the moment `phase-4-project-planner-agent` lands. The exhaustiveness itself is a TypeScript concern (the compiler enforces it once the union has three arms); the per-site behavioral fixtures (view-model bucketing, budget-service aggregation, error-log labeling) are TDD-applicable.

Test files (write first): the RED targets per site differ — pick the right one for each.
- error-log (behavioral RED). `test/unit/runtime/error-log.test.ts` (or sibling) — assert a project run is labeled `"project"` in error-log output. Today's code labels it `"feature"` via the `else` arm, so this RED is observable without a compile error.
- view-model (behavioral RED via exported `projectRuns` bucket). `test/unit/tui/view-model.test.ts` — assert the view-model exposes a distinct `projectRuns` bucket containing the project-arm rows. Today's `:153` `else` swallows project rows into `featurePhaseRuns`, so the assertion is RED until the bucket is added. The `projectRuns` bucket itself is the contract this step ships — export it from the view-model alongside `taskRuns` / `featurePhaseRuns`. Do not fall back to "exhaustiveness compile RED" or hedge on the export surface; the behavioral RED via `projectRuns` is the pinned target.
- budget-service (exhaustiveness compile RED only). Today the global `totalUsd`/`totalCalls` aggregation at `:33-34` runs before the `scopeType` branch, so a behavioral assertion "project counts toward global spend" is already GREEN on `main` — that is not a writable RED. This phase's contract for budget-service is exhaustiveness: replace the chained `if (... === 'task')` / `if (... === 'feature_phase')` with an exhaustive switch + `assertNever`, so adding the `'project'` arm in Step 2.1 immediately compile-REDs this file until the arm is handled. Note this as a typecheck-RED step, not an assertion-RED step.
- `dispatch.ts` / `recovery-service.ts` (exhaustiveness compile RED). Same pattern: switch + `assertNever`. Compile RED until the project arm carries either real handling or an explicit "`phase-4-project-planner-agent` wires this" stub.

Prod files (verified call sites on `main`):
- `src/orchestrator/scheduler/dispatch.ts` — `createRunReader` and any sibling that branches on `scopeType`. Project runs are dispatched in `phase-4-project-planner-agent`; the change here is an exhaustive branch (with a "`phase-4-project-planner-agent` wires this" placeholder if it cannot be fully implemented yet) rather than a silent fallthrough.
- `src/orchestrator/services/recovery-service.ts` — `recoverOrphanedRuns` currently sweeps task and feature_phase runs only. Add explicit project-arm handling (`phase-4-project-planner-agent` defines the recovery semantics; here, at minimum, no silent crash and no miscategorization).
- `src/runtime/error-log/index.ts` — non-task runs are currently labeled `"feature"`. Add a `"project"` label so logs disambiguate.
- `src/tui/view-model/index.ts:153` — current code is `if (run.scopeType === 'task') ... else featurePhaseRuns.set(...)`; the bug being fixed is that the `else` swallows project runs into the feature-phase bucket. Replace with an exhaustive switch, adding a `projectRuns` bucket. `phase-6-tui-mode` wires the bucket to a render path; this phase just creates it.
- `src/orchestrator/services/budget-service.ts:36,46` — currently branches on `'task'` and `'feature_phase'`. Decision: project-scope `token_usage` counts toward global spend, with no per-feature attribution. Add the `'project'` arm explicitly with a one-line comment stating the rationale and route into the existing global-aggregation path. No change to `byPhase` / `byScope` aggregations beyond that.

Tests (write first, expect red):
- Each touched call site has a project-arm fixture and a deterministic assertion that it is handled explicitly.
- No regression in existing task / feature_phase coverage.

Red → green workflow:
1. For error-log (behavioral): write the project-arm label fixture; `npm run test:unit` RED (labels `"feature"`); add the project arm; GREEN.
2. For view-model: write the bucket-existence assertion against whichever surface the view-model exports for run lookup; RED; add the bucket; GREEN.
3. For `budget-service`, `dispatch.ts`, and `recovery-service.ts`: refactor the chained `if/else` into `switch + assertNever`. `npm run typecheck` then enforces RED until the project arm carries either real handling or an explicit "`phase-4-project-planner-agent` wires this" stub. No behavioral test required at this site (`phase-4-project-planner-agent` owns that coverage).

Verification: `npm run check:fix && npm run check`.

Review goals:
1. Verify every site listed in the Step 2.3 prod-files block (`scheduler/dispatch.ts`, `services/recovery-service.ts`, `runtime/error-log/index.ts`, `tui/view-model/index.ts:153`, `services/budget-service.ts`) carries a project arm.
2. Verify those arms either implement the right behavior or carry an explicit "`phase-4-project-planner-agent` wires this" marker — never a silent fallthrough.
3. Verify error-log labels distinguish project from feature.
4. Verify the view-model exposes a distinct `projectRuns` bucket.
5. Verify tests cover at least one project-arm fixture per touched behavioral site (error-log + view-model).
6. Confirm the out-of-scope call sites stay narrow on purpose: `src/compose.ts` feature-scoped helpers (`cancelFeatureRunWork`, the various `run?.scopeType !== 'feature_phase'` and `!== 'task'` guards), `src/orchestrator/scheduler/events.ts:182` (task-only event handler), and the literal-write sites at `src/tui/proposal-controller.ts:278` / `src/agents/tools/feature-phase-host.ts:90` are correct without a project arm — they intentionally narrow to feature/task scope and should not be touched by Step 2.3.
7. Keep the review under 350 words.

Commit: `refactor(orchestrator): exhaust scopeType switches across orchestrator/runtime/tui`
