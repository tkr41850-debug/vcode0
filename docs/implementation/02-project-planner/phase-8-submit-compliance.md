# Phase 8 — Submit-compliance hardening

Status: drafting
Verified state: as of a5abfeae9b1e59ee53d8c850da7203fdc146521a on 2026-05-01
Depends on: phase-1-scheduler-hygiene (failed-run filter prevents loop while testing), phase-3-toolset-split (toolset constructed at agent-creation), phase-4-project-planner-agent (project planner agent surface), phase-7-escalation-prompt (escalation prompt baseline)
Default verify: npm run check:fix && npm run check
Phase exit: Full ship (Shapes 1 or 2) requires `npm run verify`, clean real-LLM `/init` + `/auto` submit behavior, and deterministic regression coverage that is RED with tool_choice opt-out and GREEN with tool_choice on; Partial ship (Shape 3) requires `npm run verify`, prompt hardening plus regression-anchor coverage, and a bounded legacy failure with no re-dispatch.
Doc-sweep deferred: none

## Contract

Goal: Eliminate the failure mode where a planner agent finishes its turn without calling `submit`, which today throws `"<phase> phase must call submit before completion"`. phase-1-scheduler-hygiene's failed-run filter already prevents that failure from re-dispatch looping while this phase hardens the underlying contract. If Step 8.2 ships Shape 3 (defer SDK), this phase ships only the prompt + regression-anchor; the LLM-side failure mode is reduced but not eliminated, and a follow-up phase must complete the SDK side.

Scope:
  In: SDK-level tool_choice forcing (or in-tree wrapper, per Step 8.2's three shapes) that compels the agent to call `submit` (or `submitDiscuss` / `request_help`) before completing its turn; prompt hardening for project planner and feature plan/replan agents to make the submit-call expectation unambiguous; deterministic-LLM regression test that reproduces the original failure mode and proves the fix.
  Out: changing the `request_help` flow; changing the proposal-host invariants; changing `decideRetry` semantics for any failure; introducing new tool variants or new run statuses.
Exit criteria:
  Full ship (Step 8.2 lands tool_choice forcing — Shapes 1 or 2):
  - All three commits land in order.
  - `npm run verify` passes.
  - Real-LLM `/init` + `/auto` does not produce the plain-text-only failure path observed in the original investigation. Manual verification on a fresh project root: greenfield bootstrap → project planner produces a graph proposal that submits cleanly.
  - The regression test fails on the tool_choice opt-out baseline and passes with tool_choice on.
  - Run a final review subagent across all three commits to confirm the prompt + SDK + test fix is coherent and no failure mode is silently absorbed.
  Partial ship (Step 8.2 picks Shape 3 — defer SDK wiring):
  - Commits 8.1 (prompt) and 8.3 (regression anchor) land in order; 8.2 is deferred to a follow-up phase tracked under `docs/feature-candidates/runtime/` or equivalent.
  - `npm run verify` passes.
  - The regression test asserts the legacy failure mode stays the failure mode: a plain-text-only faux response causes the run to land in `runStatus='failed'` via the existing `"<phase> phase must call submit before completion"` path; phase-1-scheduler-hygiene's failed-run filter prevents re-dispatch (no infinite loop). The "passes with tool_choice on" assertion is not required under Shape 3.
  - Real-LLM verification is reduced: the prompt hardening should reduce but not eliminate plain-text completions; the regression test guards the failure-handling path so any remaining LLM misbehavior is bounded.
  - Run a final review subagent on the two landed commits to confirm the prompt + regression-anchor are coherent and the LLM-side failure mode is reduced.

## Plan

### Background

Verified state at the pinned SHA:

- `src/agents/runtime.ts` `startPlanFeature` / `startReplanFeature` → `startProposalPhase` → `executeAgent(...)`. If the agent finishes without `submit`, `executeAgent` throws `"<phase> phase must call submit before completion"`. `src/orchestrator/scheduler/dispatch.ts` then emits `feature_phase_error`; `src/orchestrator/scheduler/events.ts` routes it through `decideRetry`, which writes inbox `semantic_failure` and sets `runStatus='failed'`.
- `decideRetry` (`src/runtime/retry-policy.ts`) classifies the resulting error against `transientPatterns` (ECONN*, ETIMEDOUT, network, 429, 5xx, rate.limit). Submit-compliance errors match none → `escalate_inbox: semantic_failure`.
- phase-1-scheduler-hygiene stops the re-dispatch loop on `runStatus='failed'`. The failure still happens; it just does not loop. Operator sees a failed-run icon and an inbox row.
- Real-LLM behavior observed: with the current prompt and free tool choice, the LLM sometimes returns plain text without invoking `submit`, particularly on simple inputs. The discrepancy with `fauxModel` integration tests masked the issue (faux scripts always include the `submit` call). The current `src/agents/prompts/plan.ts` already says "do not end with free-text plan" and to call `submit(...)`; the prompt is partial, not absent — Step 8.1 hardens an existing contract.
- Tool_choice forwarding does not exist in the installed pi-agent-core today. `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` shows `Agent.prompt()` and `Agent.continue()` accept no options. Resumed planner sessions go through `agent.continue()`, not just `agent.prompt()`. The underlying provider drivers (`@mariozechner/pi-ai`) expose `toolChoice` in their typings (Anthropic, OpenAI, Mistral), but `pi-agent-core` does not currently forward any `toolChoice` field through `Agent` to `streamSimple`. Step 8.2 cannot pass tool_choice "at each `agent.prompt(...)` call" against the installed SDK and must instead either (a) extend pi-agent-core upstream to forward `toolChoice`, (b) wrap/replace the `Agent` in our runtime with one that calls `streamSimple` directly with `toolChoice`, or (c) defer to a prompt-only fix in this phase and revisit when pi-agent-core grows the surface. Decide during implementation; document the choice in the commit message.
- Faux-model harness exists: `test/integration/harness/faux-stream.ts`, used by `test/integration/feature-phase-agent-flow.test.ts`. Plain-text/no-submit regression-style cases already exist in `test/unit/agents/runtime.test.ts` — Step 8.3 extends rather than starts.
- `request_help` callback wiring is the seam this phase must preserve. `src/agents/tools/agent-toolset.ts` only includes `request_help` when a callback is supplied; tests confirm this in `test/unit/agents/tools/planner-toolset.test.ts`. Forcing tool-call completion (Step 8.2) must keep `request_help` in the allowed set.

### Notes

- Ship order follows the `Depends on` chain in the header. `phase-4-project-planner-agent` must land for project-planner regression coverage, and `phase-7-escalation-prompt` is the prompt-edit base.
- Why prompt + tool_choice both: either alone is fragile. Prompt hardening alone leaves the LLM free to ignore the rule; tool_choice alone leaves the prompt ambiguous and produces poorer LLM reasoning. Together they make the contract explicit and enforced.
- Shape 3 ships incomplete. If Step 8.2 picks Shape 3 (defer SDK), this phase ships only the prompt + regression-anchor and the LLM-side failure mode is reduced but not eliminated. The phase-exit criterion "real-LLM /init + /auto does not produce the plain-text-only failure" is then a best-effort assertion rather than a hard gate; a follow-up phase must complete the SDK side. Document this clearly in the commit message and exit notes if Shape 3 is chosen.
- No retry-policy change. This phase does not reclassify any error. `decideRetry` is not modified by this phase — submit-compliance failures continue to classify as `semantic_failure` and escalate to `runStatus='failed'`. phase-1-scheduler-hygiene's failed-run filter prevents the loop. The Scope/Background mention of `decideRetry` is descriptive (current behavior reference), not deliverable.
- Real-LLM verification. The commit-level review subagent should run the test suite. A separate manual smoke against a real Claude model on a fresh project root is recommended as a final gate before declaring the phase exit criteria met.

## Steps

Ships as 3 commits, in order.

---

### Step 8.1 — Prompt hardening [risk: low, size: S]

Approach: Prompt prose; behavior is covered by 8.3 regression test (no test added in this step).

What: Update the project-planner and feature plan/replan prompts to be unambiguous about the submit-call expectation. Concretely: a short, explicit paragraph at the end of the system prompt stating that the agent must call `submit` to complete its turn; that returning plain text without a tool call is treated as failure; that `request_help` is the correct tool for "I need more information" cases. Add a one-line example.

Files:

- `src/agents/prompts/project-planner.ts` (created in `phase-4-project-planner-agent` step 4.1) — add submit-expectation paragraph.
- `src/agents/prompts/plan.ts` — covers both feature-plan and feature-replan (replan reuses plan's prompt). Single edit covers both phases. Existing prompt already partially asserts the contract; `phase-7-escalation-prompt` added a topology-escalation paragraph; Step 8.1 makes the submit-call expectation explicit on top of those edits.
- `src/agents/prompts/discuss.ts` — add submit-expectation paragraph. Note: discuss completes via `submitDiscuss`, not `submit`. The wording must reflect the per-phase tool name. (`phase-7-escalation-prompt` added the topology-escalation paragraph to this file; Step 8.1 builds on that.)
- `docs/agent-prompts/*.md` — sync the prose mirrors (`docs/agent-prompts/plan-feature.md`, `discuss-feature.md`, and the new `project-planner.md`); the `.md` files under `docs/agent-prompts/` are documentation, not the live source.
- `docs/agent-prompts/README.md` — describe the submit-call invariant.

Tests:

- No new tests for prompt content alone; the regression test in Step 8.3 covers behavior.

Verification: `npm run check:fix && npm run check`.

Review goals (under 250 words):
1. All four planner prompts include the submit-expectation paragraph.
2. Prompts are unambiguous about plain-text completion being a failure.
3. `request_help` is identified as the correct fallback for "need more info".
4. `docs/agent-prompts/README.md` reflects the invariant.

Commit: `feat(agents/prompts): clarify submit-call invariant in planner prompts`

---

### Step 8.2 — Tool_choice forcing at SDK call site [risk: med, size: M]

Approach: TDD for the runtime-boundary slice (assert tool_choice forced on prompt + continue); SDK shape selection is exploratory and lands afterwards.

What: Force the planner agent to complete with a tool call (`submit` / `submitDiscuss` / `request_help`) instead of free text. The runtime-boundary contract is: every `agent.prompt(...)` / `agent.continue(...)` call from a proposal-bearing phase carries a tool_choice that forbids free-text completion. The constraint, once wired, is `tool_choice: 'any'` (or the provider equivalent for "any tool from the agent's toolset") — not a name-allowlist. The full toolset (including `addTask`, `editTask`, `addDependency`, `setFeatureObjective`, all proposal-host mutations, `submit`, `submitDiscuss`, `request_help`) must remain callable; the constraint only forbids text-only turns. Both `prompt` and `continue` paths must carry it — resumed sessions go through `continue`, not `prompt`.

Test (write first, expect red):

- `test/unit/agents/runtime.test.ts` — assert that the runtime, when invoking a proposal-bearing phase (`startProposalPhase`, `startPlanFeature`, `startReplanFeature`, project-planner equivalent from `phase-4-project-planner-agent`), passes the expected tool_choice value through to the agent boundary on both the initial `prompt` call and any resumption `continue` call. On current `main` these assertions fail (no tool_choice is forwarded) — confirm RED before implementation.
- Resumption coverage is not optional: it is regression coverage to prevent the resume path from drifting.

Implementation: Turn the failing assertions GREEN by threading `toolChoice` through the runtime boundary at every prompt/continue call site for proposal-bearing phases.

- `src/agents/runtime.ts` — at each prompt/continue call site for proposal-bearing phases, pass tool_choice that forbids free-text completion. Resumption (`agent.continue(...)`) must carry it as well.

Verification: `npm run check:fix && npm run check`. Re-run the unit test added above; it must now be GREEN.

#### SDK-shape exploration (lands after the runtime-boundary slice is GREEN)

The installed pi-agent-core does not forward `toolChoice` through `Agent.prompt()` / `Agent.continue()` today, so the runtime-boundary slice needs an SDK-side delivery mechanism. Three viable shapes:

1. Upstream pi-agent-core to forward an optional `toolChoice` field from `Agent.prompt({ toolChoice })` / `Agent.continue({ toolChoice })` to `streamSimple`. Most surgical; preferred if upstream review timing allows.
2. Replace `Agent` in our runtime with a thin wrapper that owns the `streamSimple` call and threads `toolChoice` directly. Keeps the change in-tree but duplicates a small slice of `Agent`'s loop. Pick this if upstream is gated.
3. Defer the SDK change to a follow-up; ship this phase as prompt + regression test only. Documented as a known gap; revisit when 1 or 2 unblocks.

Shape selection is exploratory: decide during implementation, document the choice in the commit message.

Files (shape-dependent):

- `node_modules/@mariozechner/pi-agent-core/...` (if shape 1 chosen) — upstream change. Out of repo; track separately.
- `src/agents/runtime.ts` (if shape 2 chosen) — wrap `Agent` so `streamSimple` is called directly with `toolChoice`. Keep the wrapper minimal.

Review goals (under 300 words):
1. `agent.prompt(...)` calls for proposal phases pass tool_choice.
2. The choice is `'any'` (or provider equivalent), not a name-allowlist, so proposal-host mutations (`addTask`, `editTask`, `addDependency`, etc.) remain callable alongside `submit` / `submitDiscuss` / `request_help`.
3. Text-only completion is rejected.
4. No fork of pi-agent-core was introduced.
5. The change is isolated to proposal-bearing phases and does not affect non-proposal agent uses, if any.

Commit: `feat(agents/runtime): force tool-call completion on proposal phases`

---

### Step 8.3 — Deterministic regression test [risk: low, size: S]

Approach: TDD (test-first) — this regression test is the deliverable.

What: Write the regression test first. The faux model returns plain text on a plan-phase turn, reproducing the original failure mode. Confirm the test is RED on current `main` (legacy failure path observable). Then verify that Step 8.2's tool_choice forcing flips it GREEN — the plain-text-only response is rejected at the boundary rather than silently skipping `submit`. Two assertions:

- With tool_choice forcing in place (Step 8.2 GREEN), the faux model setup that produced plain text now produces an error with a clear "model returned text without a tool call" message (or equivalent SDK signal) rather than the silent skip-submit path.
- Legacy behavior, still reachable in test by disabling tool_choice via an opt-out, reproduces the original failure as a baseline; this acts as a regression anchor and is documented as such. This is the same RED state used to confirm the test exercises the failure mode before Step 8.2 lands.

Files:

- `test/integration/feature-phase-agent-flow.test.ts` — add regression coverage for `plan` and `replan` (replan path uses the same prompt and the same toolset; covered with a thin variant of the plan test). Reuse the existing faux-model harness in `test/integration/harness/faux-stream.ts`; add a faux response that emits text only.
- `test/integration/project-planner-flow.test.ts` (new, if `phase-4-project-planner-agent` did not already create one) — equivalent coverage for project-planner runs.
- `test/helpers/faux-responses.ts` (or existing helpers location) — add a typed helper for "plain-text-only response" that is reusable across tests.

Tests:

- Plain-text-only faux response from a feature-plan run is rejected by the SDK (or runtime wrapper) due to tool_choice; the run does not silently skip `submit`; the run lands in `runStatus='failed'` after `decideRetry` classifies the error as `semantic_failure` (`phase-1-scheduler-hygiene`'s failed-run filter then prevents re-dispatch). If Step 8.2 ships Shape 3 (defer SDK), this test asserts the existing `"<phase> phase must call submit before completion"` path stays the failure mode and is not infinite-looped — that is, this phase ships only the prompt + regression-anchor.
- Same coverage for a feature-replan run.
- Same coverage for a project-planner run.
- Existing happy-path faux-model tests stay green.

Verification:
- Run the new regression cases in isolation against current `main` first; they must fail RED with the legacy `"<phase> phase must call submit before completion"` error path. Confirm RED before proceeding.
- Full ship (Shape 1 or 2): with Step 8.2's tool_choice forcing in place, the same faux setup transitions to GREEN — the failure mode is now a typed "model returned text without a tool call" error rather than the legacy silent skip-submit path. The legacy baseline assertion (tool_choice opt-out) stays GREEN as a regression anchor.
- Partial ship (Shape 3): the legacy `"<phase> phase must call submit before completion"` failure stays the GREEN assertion — the test guards `phase-1-scheduler-hygiene`'s failed-run filter (no infinite loop) and the failure-handling path; the "tool_choice on" GREEN assertion is omitted.
- Then `npm run check:fix && npm run check`.

Review goals (under 400 words):
1. Faux-model plain-text response is exercised.
2. Tool_choice forcing causes a typed failure rather than the silent skip-submit path (full ship), or the legacy `"<phase> phase must call submit before completion"` failure mode is preserved with no infinite loop (Shape 3 partial ship).
3. Coverage exists for all three proposal-bearing run kinds — feature-plan, feature-replan, and project-planner.
4. `phase-1-scheduler-hygiene`'s failed-run filter prevents re-dispatch in this scenario.
5. The faux-response helper is reusable.
6. The review identifies which exit shape the implementation took (Shape 1, 2, or 3) and confirms the assertions match that shape.

Commit: `test: regression for tool-call-required completion on planner runs`
