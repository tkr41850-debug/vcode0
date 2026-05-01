# Phase 7 — Escalation prompt + UX

Status: drafting
Verified state: as of a5abfeae9b1e59ee53d8c850da7203fdc146521a
Depends on: phase-3-toolset-split (toolset architecture for plan/replan)
Default verify: npm run check:fix && npm run check
Phase exit: `npm run verify` passes; a faux-model integration test exercises the topology-escalation flow end-to-end; `docs/agent-prompts` documents the pattern; final review confirms the escalation pattern is real, discoverable, and does not introduce a new wait state.
Doc-sweep deferred: none

Ships as 1–2 commits, in order. Step 7.1 is required; Step 7.2 is optional UX polish that may be deferred.

## Contract

Goal: Make the feature-planner escalation path real and discoverable. Feature discuss / plan / replan agents that detect a topology issue use the existing `request_help` tool with a topology-flavored query. The operator sees the request, can resolve by replying ("keep current scope") or by opening project-planner mode, editing the graph, and replying ("done, see new graph state"). Optionally introduce a structured `topology_request` inbox kind for click-through to "open project planner with this context".

Scope:
  In:
    - prompt updates for feature discuss / plan / replan agents
    - documentation of the topology-escalation pattern
    - optional structured `topology_request` inbox kind with TUI affordance
    - integration test for the escalation flow
  Out:
    - changing `request_help` semantics or adding a new wait state
    - auto-spawning project planner from feature planner
    - mutating graph topology directly from a feature-scope agent (still rejected by `phase-3-toolset-split`)

Exit criteria:
  - Step 7.1 commits land.
  - Step 7.2 commits land if the team chooses to ship the structured kind in this phase; otherwise it is deferred to a follow-up.
  - `npm run verify` passes.
  - A faux-model integration test exercises the topology-escalation flow end-to-end.
  - `docs/agent-prompts` documents the pattern.
  - Run a final review subagent on the shipped commits to confirm the escalation pattern is real, discoverable, and does not introduce a new wait state.

## Plan

Background:

- `request_help` is real. For feature plan/replan agents it is defined in `src/agents/tools/agent-toolset.ts` and blocks via `LiveProposalPhaseSession.requestHelp/respondToHelp` in `src/agents/runtime.ts`. Worker-scope tasks have a separate `request_help` tool in `src/agents/worker/tools/request-help.ts`.
- The existing wait state is `await_response` (defined in `src/core/types/runs.ts`). Feature-phase planner help sets it in `src/compose.ts`; worker IPC help sets it in `src/orchestrator/scheduler/events.ts`. The runtime persists the help query in `agent_runs.payload_json` and the TUI reads it from the run row in `src/tui/view-model/index.ts`.
- The inbox kind union lives in `src/core/types/inbox.ts` and is currently exactly `semantic_failure | retry_exhausted | destructive_action | squash_retry_exhausted`. DB enforcement is in `src/persistence/migrations/010_inbox_items.ts`. A `topology_request` kind would extend both.
- Today there is no `request_help` → inbox path. Help queries surface only through the run row; no escalation handler appends an `inbox_items` row when `request_help` is invoked. Step 7.2 is the place to add that, if shipped. Step 7.1 alone produces a working escalation that surfaces via the existing run-payload path.
- The discuss phase is the cheapest capture point for topology issues. Today neither `src/agents/prompts/discuss.ts` nor `src/agents/prompts/plan.ts` carry topology-escalation guidance. By the time work reaches `plan`, the spec contract is set; topology escalation from `plan` should be a rare exception.

Notes:

- Why step 7.2 is optional: plain-text `request_help` already works; the structured kind is UX polish. If the team ships 7.1 and watches usage, the demand for click-through becomes evident from operator behavior. Defer 7.2 if there is no clear pull.
- Discuss-phase emphasis: the prompts should make clear that catching scope issues in discuss is the primary path. Plan/replan escalation is the safety net, not the routine path.
- No auto-spawn: the feature planner does not spawn a project-planner run on its own. Operator mediation is the design.

## Steps

---

### Step 7.1 — Wire `request_help` into discuss + add prompt guidance for topology escalation [risk: low, size: S]

Approach: TDD for the wiring slice (faux-model help flow); prompt prose tuned afterwards.

What: two coupled sub-tasks.

1. Tool wiring (TDD slice). `request_help` is part of `buildProposalAgentToolset` (`src/agents/tools/agent-toolset.ts`), which today is only used by plan/replan. Discuss uses `buildFeaturePhaseAgentToolset` and does not have `request_help`. Without the tool, prompt edits cannot make discuss escalation real. Extend the discuss toolset to include `request_help` (and the matching help-response callback wiring in `src/agents/runtime.ts:359-371`). Replan already inherits the tool through plan's toolset (replan and plan are constructed via the same path); no change there.
2. Prompt edits (prose, post-wiring). Update the discuss / plan / replan agent prompts so the agent knows when to call `request_help` for a topology-flavored question. Concretely: a short paragraph explaining the scope discipline (this agent cannot mutate topology), the conditions where escalation is appropriate (spec doesn't fit one feature; needs split; depends on a feature that doesn't exist; etc.), and the format for the help query (a structured prefix like `[topology] ...` so the inbox can flag it).

Test (write first, expect red): write the discuss-phase analogue of the existing plan help test in `test/unit/agents/runtime.test.ts` (where today's plan `request_help` flow lives): scripted faux-model `request_help({ query: '[topology] f-3 spec is too broad...' })` from a discuss agent pauses the run at `await_response`; `respondToHelp(...)` resumes the agent; `submitDiscuss` then completes. RED initially: discuss runs go through `runTextPhase(...)` and return `Promise<DiscussPhaseResult>` directly with no `LiveProposalPhaseSession`-style help session — the toolset lacks `request_help` and there is no help-callback plumbing. Pin the RED to "discuss cannot reach `await_response` and resume" rather than a specific SDK error string the harness may not expose. Add thin variants for plan and replan to cover both proposal toolset paths.

Implementation: wire `request_help` into the discuss toolset and the matching help-response callback so the test goes GREEN. Then iterate the prompt prose (paragraphs in `discuss.ts` / `plan.ts` and the `docs/agent-prompts` mirrors) with the wiring as a safety net — the integration test stays green while the prose is tuned.

Files:

- `src/agents/runtime.ts` — extend the discuss agent construction (`:359-371`) to wire `request_help` into the discuss toolset. New callback wiring required, not shared. Today only proposal phases (`startProposalPhase`, `:381`) wire help via `LiveProposalPhaseSession`; discuss has no help-callback infrastructure. Step 7.1 introduces analogous wiring for discuss — either reuse `LiveProposalPhaseSession` (rename if it grows beyond proposal phases) or create a sibling `LiveDiscussPhaseSession`. Pick whichever lands more cleanly with the existing discuss session lifecycle in `runtime.ts`.
- `src/agents/tools/agent-toolset.ts` — `request_help` is currently only added by `buildProposalAgentToolset`. Extend `buildFeaturePhaseAgentToolset` (added in `phase-3-toolset-split` with extensible signature) to optionally accept a help-response callback and include `request_help` when one is supplied. The discuss path supplies one; research / verify / summarize do not.
- `src/agents/prompts/discuss.ts` — add escalation paragraph. Note: live prompts are `.ts` files, not `.md`; the `.md` files under `docs/agent-prompts/` are documentation mirrors.
- `src/agents/prompts/plan.ts` — add escalation paragraph; emphasize this should be rare for plan and that scope issues should be caught in discuss. Replan shares this prompt — single edit covers both.
- `docs/agent-prompts/discuss-feature.md` and `docs/agent-prompts/plan-feature.md` — sync the prose mirrors.
- `docs/agent-prompts/README.md` — document the escalation pattern alongside the prompt files.
- `test/integration/feature-phase-agent-flow.test.ts` — faux-model integration tests for both plan and discuss runs: scripted agent emits a `request_help` call with a `[topology]` prefix; assert the run goes to `await_response`, the help query persists on `agent_runs.payload_json`, and the TUI surfaces the request from the run row with topology framing. No inbox row in 7.1 — see Step 7.2. Replan coverage can be a thin variant of the plan test.

Verification:

- Discuss faux-model test: `request_help({ query: '[topology] ...' })` pauses at `await_response`; `respondToHelp` resumes; `submitDiscuss` completes (RED before wiring, GREEN after).
- Plan faux-model test: same flow puts the run in `await_response` and resumes via `respondToHelp`.
- Replan faux-model test: thin variant of the plan test.
- Help query is persisted on `agent_runs.payload_json` and the TUI surfaces it from the run row (existing path). Step 7.1 does not add an inbox row — that is Step 7.2 territory.
- `npm run check:fix && npm run check`.

Review goals (cap 400 words):

1. Verify the wiring slice: `buildFeaturePhaseAgentToolset` extension wires `request_help` into the discuss toolset when a help-response callback is supplied.
2. Verify the wiring slice: `src/agents/runtime.ts:359-371` constructs the discuss agent with the matching help-callback, either by reusing `LiveProposalPhaseSession` or via a sibling `LiveDiscussPhaseSession`; note which landed.
3. Verify the discuss faux-model test reaches `await_response` and resumes via `respondToHelp`, then `submitDiscuss` completes.
4. Verify the prompt slice: discuss / plan / replan prompts include the escalation paragraph.
5. Verify discuss is identified as the primary capture point.
6. Verify `docs/agent-prompts/discuss-feature.md`, `docs/agent-prompts/plan-feature.md`, and `docs/agent-prompts/README.md` mirrors are synced.
7. Boundaries: verify no new wait state is introduced.
8. Boundaries: verify Step 7.1 does not write an inbox row; Step 7.2 owns that boundary.

Commit: `feat(agents/prompts): topology-escalation guidance in feature-planner prompts`

---

### Step 7.2 — Optional structured `topology_request` inbox kind [risk: low, size: S]

Approach: TDD (test-first).

What: introduce `topology_request` as a new inbox kind. Inbox rows of this kind carry the originating run id and the help-query text; the TUI renders a click-through affordance that opens project-planner mode pre-seeded with the help-query text as the new session's first user message. Detection is by the `[topology]` prefix on the help query — no new tool variant.

Click-through resolves nothing on its own. Opening project-planner mode does not auto-resolve the originating feature-planner help request. The operator must still reply via `/reply` (or `session.respondToHelp`) on the original feature run before its agent resumes. The click-through is a navigation aid, not a resolution.

Test (write first, expect red):

- Inbox-writer test: invoking the help-request path with `request_help({ query: '[topology] ...' })` writes an `inbox_items` row with `kind='topology_request'`; a non-prefixed query (`request_help({ query: 'unrelated...' })`) writes no inbox row. RED before the classifier + writer exist (`topology_request` not in the kind union; CHECK constraint rejects it; no writer in `events.ts`).
- TUI click-through test: the inbox affordance for a `topology_request` row opens project-planner mode with the help-query seeded as the new session's first user message; the originating feature run remains in `await_response`. RED before the renderer extension lands.
- Regression: existing inbox kinds continue to write and render correctly.

Implementation: add `topology_request` to the kind union, ship the CHECK-constraint relaxation migration, add the `[topology]`-prefix classifier + inbox writer in `events.ts`, and extend the inbox renderer with the click-through affordance. Tests go GREEN.

Files:

- `src/core/types/inbox.ts` — extend the kind union with `topology_request`. Inbox kinds live here, not under `src/orchestrator/inbox/`.
- `src/persistence/migrations/NNN_inbox_topology_request.ts` (new) — extend the `kind IN (...)` CHECK constraint added by `010_inbox_items.ts:12-16` with `'topology_request'`. SQLite does not allow modifying a CHECK constraint in-place: the migration must `CREATE TABLE inbox_items_new ...` with the new constraint, `INSERT INTO inbox_items_new SELECT ... FROM inbox_items`, `DROP TABLE inbox_items`, `ALTER TABLE inbox_items_new RENAME TO inbox_items`, recreate any indexes. Standard SQLite CHECK-relaxation pattern; mirror whatever convention already-shipped relax migrations use in this repo.
- `src/orchestrator/scheduler/events.ts` — in the help-request path, detect the `[topology]` prefix and write an `inbox_items` row with `kind='topology_request'`. Today no inbox row is written for `request_help` at all; this is the first such writer.
- TUI inbox renderer. `phase-6-tui-mode` ships no inbox surface (its scope is composer chrome, mode entry, auto-enter, approval surface). Step 7.2 owns locating the inbox-item rendering site that exists on `main` for the current four kinds (e.g. `src/tui/components/` or `src/tui/view-model/index.ts`'s inbox bucket), and extending it for `topology_request` with the click-through affordance that calls `/project` programmatically with the help-query as seeded context. If no inbox renderer exists on `main` either, Step 7.2 builds one — note this expands Step 7.2's scope and may justify deferring to a follow-up phase.
- `test/unit/core/inbox.test.ts` (or wherever inbox unit tests live) — coverage for the new kind and the prefix classifier.
- `test/integration/tui/smoke.test.ts` — coverage for the click-through opening project-planner mode with seeded context.

Verification:

- Inbox-writer unit/integration test: topology-prefixed `request_help` appends a `topology_request` row; non-prefixed `request_help` appends none (RED before classifier + writer; GREEN after).
- TUI click-through test: clicking the affordance opens project-planner mode with seeded context; the originating feature run stays in `await_response` until the operator explicitly replies.
- Existing inbox kinds continue to write and render correctly.
- `npm run check:fix && npm run check`.

Review goals (cap 350 words):

1. Verify `topology_request` kind is defined and persisted.
2. Verify the detection rule is the `[topology]` prefix only; no tool variant is introduced.
3. Verify the TUI affordance opens project-planner mode with seeded context.
4. Verify other inbox kinds are unaffected.
5. Verify the click-through does not auto-resolve the originating help request; the operator must reply explicitly.

Commit: `feat(core/inbox): topology_request kind with project-planner click-through`
