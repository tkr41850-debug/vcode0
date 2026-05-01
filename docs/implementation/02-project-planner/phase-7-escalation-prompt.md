# Phase 7 — Escalation prompt + UX

## Goal

Make the feature-planner escalation path real and discoverable. Feature discuss / plan / replan agents that detect a topology issue use the existing `request_help` tool with a topology-flavored query. The operator sees the request, can resolve by replying ("keep current scope") or by opening project-planner mode, editing the graph, and replying ("done, see new graph state"). Optionally introduce a structured `topology_request` inbox kind for click-through to "open project planner with this context".

## Scope

**In:** prompt updates for feature discuss / plan / replan agents; documentation of the topology-escalation pattern; optional structured `topology_request` inbox kind with TUI affordance; integration test for the escalation flow.

**Out:** changing `request_help` semantics or adding a new wait state; auto-spawning project planner from feature planner; mutating graph topology directly from a feature-scope agent (still rejected by Phase 3 toolset split).

## Background

Verified state on `main`:

- `request_help` is real. For feature plan/replan agents it is defined in `src/agents/tools/agent-toolset.ts` and blocks via `LiveProposalPhaseSession.requestHelp/respondToHelp` in `src/agents/runtime.ts`. Worker-scope tasks have a separate `request_help` tool in `src/agents/worker/tools/request-help.ts`.
- The existing wait state is `await_response` (defined in `src/core/types/runs.ts`). Feature-phase planner help sets it in `src/compose.ts`; worker IPC help sets it in `src/orchestrator/scheduler/events.ts`. The runtime persists the help query in `agent_runs.payload_json` and the TUI reads it from the run row in `src/tui/view-model/index.ts`.
- The inbox kind union lives in `src/core/types/inbox.ts` and is currently exactly `semantic_failure | retry_exhausted | destructive_action | squash_retry_exhausted`. DB enforcement is in `src/persistence/migrations/010_inbox_items.ts`. A `topology_request` kind would extend both.
- **Today there is no `request_help` → inbox path.** Help queries surface only through the run row; no escalation handler appends an `inbox_items` row when `request_help` is invoked. Step 7.2 is the place to add that, if shipped. Step 7.1 alone produces a working escalation that surfaces via the existing run-payload path.
- The discuss phase is the cheapest capture point for topology issues. Today neither `src/agents/prompts/discuss.ts` nor `src/agents/prompts/plan.ts` carry topology-escalation guidance. By the time work reaches `plan`, the spec contract is set; topology escalation from `plan` should be a rare exception.
- **Phase 3 dependency.** Phase 7 Step 7.1 modifies `src/agents/tools/agent-toolset.ts` to extend `buildFeaturePhaseAgentToolset` with `request_help`. Phase 3 also touches `agent-toolset.ts` (where `buildProposalAgentToolset` lives). Phase 7 hard-depends on Phase 3 having landed so the toolset architecture is coherent: Phase 3 narrows plan/replan and defines the helper-callback wiring; Phase 7 then attaches `request_help` to the discuss helper using the same callback shape.

## Steps

Ships as **1–2 commits**: Step 7.1 is required; Step 7.2 is optional UX polish that may be deferred. The phase header below counts both, but exit criteria allow shipping only 7.1.

---

### Step 7.1 — Wire `request_help` into discuss + add prompt guidance for topology escalation

**What:** two coupled sub-tasks.

1. **Tool wiring.** `request_help` is part of `buildProposalAgentToolset` (`src/agents/tools/agent-toolset.ts`), which today is only used by plan/replan. Discuss uses `buildFeaturePhaseAgentToolset` and does not have `request_help`. Without the tool, prompt edits cannot make discuss escalation real. Extend the discuss toolset to include `request_help` (and the matching help-response callback wiring in `src/agents/runtime.ts:359-371`). Replan already inherits the tool through plan's toolset (replan and plan are constructed via the same path); no change there.
2. **Prompt edits.** Update the discuss / plan / replan agent prompts so the agent knows when to call `request_help` for a topology-flavored question. Concretely: a short paragraph explaining the scope discipline (this agent cannot mutate topology), the conditions where escalation is appropriate (spec doesn't fit one feature; needs split; depends on a feature that doesn't exist; etc.), and the format for the help query (a structured prefix like `[topology] ...` so the inbox can flag it).

**Files:**

- `src/agents/runtime.ts` — extend the discuss agent construction (`:359-371`) to wire `request_help` into the discuss toolset. **New callback wiring required, not shared.** Today only proposal phases (`startProposalPhase`, `:381`) wire help via `LiveProposalPhaseSession`; discuss has no help-callback infrastructure. Step 7.1 introduces analogous wiring for discuss — either reuse `LiveProposalPhaseSession` (rename if it grows beyond proposal phases) or create a sibling `LiveDiscussPhaseSession`. Pick whichever lands more cleanly with the existing discuss session lifecycle in `runtime.ts`.
- `src/agents/tools/agent-toolset.ts` — `request_help` is currently only added by `buildProposalAgentToolset`. Extend `buildFeaturePhaseAgentToolset` (added in Phase 3 with extensible signature) to optionally accept a help-response callback and include `request_help` when one is supplied. The discuss path supplies one; research / verify / summarize do not.
- `src/agents/prompts/discuss.ts` — add escalation paragraph. (Note: live prompts are `.ts` files, not `.md`; the `.md` files under `docs/agent-prompts/` are documentation mirrors.)
- `src/agents/prompts/plan.ts` — add escalation paragraph; emphasize this should be rare for plan and that scope issues should be caught in discuss. (Replan shares this prompt — single edit covers both.)
- `docs/agent-prompts/discuss-feature.md` and `docs/agent-prompts/plan-feature.md` — sync the prose mirrors.
- `docs/agent-prompts/README.md` — document the escalation pattern alongside the prompt files.
- `test/integration/feature-phase-agent-flow.test.ts` — faux-model integration tests for **both** plan and discuss runs: scripted agent emits a `request_help` call with a `[topology]` prefix; assert the run goes to `await_response`, an inbox row is written, and the TUI surfaces the request with topology framing. Replan coverage can be a thin variant of the plan test.

**Tests:**

- Scripted faux-model `request_help({ query: '[topology] f-3 spec is too broad...' })` from a discuss agent puts the run in `await_response` (this is the primary capture path; previously this would have failed because the tool was not present).
- Same scripted call from a plan agent puts the run in `await_response`.
- Same scripted call from a replan agent puts the run in `await_response`.
- Help query is persisted on `agent_runs.payload_json` and the TUI surfaces it from the run row (existing path). Step 7.1 does **not** add an inbox row — that is Step 7.2 territory.
- Operator reply via `session.respondToHelp` resumes the agent; agent continues with a stripped-down task graph proposal (plan/replan) or completes its discuss submit (discuss).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify escalation prompts: (1) discuss / plan / replan prompts include the escalation paragraph; (2) discuss is identified as the primary capture point; (3) integration test exercises the topology-flavored `request_help` flow end-to-end; (4) no new wait state was introduced; (5) `docs/agent-prompts` is updated. Under 350 words.

**Commit:** `feat(agents/prompts): topology-escalation guidance in feature-planner prompts`

---

### Step 7.2 — (Optional) Structured `topology_request` inbox kind

**What:** introduce `topology_request` as a new inbox kind. Inbox rows of this kind carry the originating run id and the help-query text; the TUI renders a click-through affordance that opens project-planner mode pre-seeded with the help-query text as the new session's first user message. Detection is by the `[topology]` prefix on the help query — no new tool variant.

**Click-through resolves nothing on its own.** Opening project-planner mode does not auto-resolve the originating feature-planner help request. The operator must still reply via `/reply` (or `session.respondToHelp`) on the original feature run before its agent resumes. The click-through is a navigation aid, not a resolution.

**Files:**

- `src/core/types/inbox.ts` — extend the kind union with `topology_request`. (Inbox kinds live here, not under `src/orchestrator/inbox/`.)
- `src/persistence/migrations/NNN_inbox_topology_request.ts` (new) — extend the `kind IN (...)` CHECK constraint added by `010_inbox_items.ts:12-16` with `'topology_request'`. SQLite does **not** allow modifying a CHECK constraint in-place: the migration must `CREATE TABLE inbox_items_new ...` with the new constraint, `INSERT INTO inbox_items_new SELECT ... FROM inbox_items`, `DROP TABLE inbox_items`, `ALTER TABLE inbox_items_new RENAME TO inbox_items`, recreate any indexes. Standard SQLite-CHECK-relaxation pattern; mirror whatever convention already-shipped relax-migrations use in this repo.
- `src/orchestrator/scheduler/events.ts` — in the help-request path, detect the `[topology]` prefix and write an `inbox_items` row with `kind='topology_request'`. (Note: today no inbox row is written for `request_help` at all; this is the first such writer.)
- **TUI inbox renderer.** Phase 6 ships no inbox surface (its scope is composer chrome, mode entry, auto-enter, approval surface). Phase 7.2 owns: locating the inbox-item rendering site that exists on `main` for the current four kinds (e.g. `src/tui/components/` or `src/tui/view-model/index.ts`'s inbox bucket), and extending it for `topology_request` with the click-through affordance that calls `/project` programmatically with the help-query as seeded context. If no inbox renderer exists on `main` either, Step 7.2 builds one — note this expands Step 7.2's scope and may justify deferring to a follow-up phase.
- `test/unit/core/inbox.test.ts` (or wherever inbox unit tests live) — coverage for the new kind.
- `test/integration/tui/smoke.test.ts` — coverage for the click-through opening project-planner mode with seeded context.

**Tests:**

- Topology-prefixed `request_help` writes an `inbox_items` row with `kind='topology_request'`.
- Non-topology `request_help` writes no inbox row (preserves today's behavior — Step 7.1 path is unaffected).
- Clicking the inbox affordance opens project-planner mode with the seeded context. The originating feature run remains in `await_response` until the operator explicitly replies on it; clicking does not move that state.
- Existing inbox kinds continue to write and render correctly.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify inbox kind: (1) `topology_request` kind is defined and persisted; (2) detection rule is the `[topology]` prefix only — no tool variant; (3) TUI affordance opens project-planner mode with seeded context; (4) other inbox kinds are unaffected; (5) the click-through does not auto-resolve the originating help request — the operator must reply explicitly. Under 350 words.

**Commit:** `feat(core/inbox): topology_request kind with project-planner click-through`

---

## Phase exit criteria

- Step 7.1 commits land. Step 7.2 commits land if the team chooses to ship the structured kind in this phase; otherwise it is deferred to a follow-up.
- `npm run verify` passes.
- A faux-model integration test exercises the topology-escalation flow end-to-end.
- `docs/agent-prompts` documents the pattern.
- Run a final review subagent on the shipped commits to confirm the escalation pattern is real, discoverable, and does not introduce a new wait state.

## Notes

- **Why Step 7.2 is optional.** Plain-text `request_help` already works; the structured kind is UX polish. If the team ships 7.1 and watches usage, the demand for click-through becomes evident from operator behavior. Defer 7.2 if there is no clear pull.
- **Discuss-phase emphasis.** The prompts should make clear that catching scope issues in discuss is the primary path. Plan/replan escalation is the safety net, not the routine path.
- **No auto-spawn.** The feature planner does not spawn a project-planner run on its own. Operator mediation is the design.
- **Phase ordering.** Phase 7 hard-depends on Phase 3 (toolset architecture must be in place). Phase 7 also shares prompt files (`src/agents/prompts/discuss.ts`, `src/agents/prompts/plan.ts`) with Phase 8 — Phase 8 hard-depends on Phase 7 having landed for the prompt edits, so Phase 7's prompt changes are the base on which Phase 8 hardens the submit-call invariant.
