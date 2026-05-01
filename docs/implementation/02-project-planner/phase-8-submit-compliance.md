# Phase 8 — Submit-compliance hardening

## Goal

Eliminate the failure mode where a planner agent finishes its turn without calling `submit`, which today throws `"<phase> phase must call submit before completion"` and (pre-Phase-1) caused an infinite re-dispatch loop. The fix combines tool-choice forcing at the SDK call site with prompt hardening on both planner scopes (project planner, feature plan/replan). Phase 1 already stops the loop; Phase 8 stops the failure itself when Shape 1 or Shape 2 of Step 8.2 ships. If Step 8.2 ships Shape 3 (defer SDK), Phase 8 ships only the prompt + regression-anchor; the LLM-side failure mode is reduced (prompt is now unambiguous) but not eliminated, and a follow-up phase must complete the SDK side.

Phase 8 hard-depends on Phase 1 (so the loop doesn't mask test signal), Phase 3 (so the prompt edits target the narrowed plan/replan toolset), Phase 4 (so project-planner regression has a real run to target), and Phase 7 (so the prompt edits build on Phase 7's escalation paragraph in `discuss.ts` and `plan.ts`). Phase 8 must ship after Phases 1, 3, 4, and 7 — it is **not** parallelizable with Phases 4–6 despite the README's earlier framing, which has been corrected.

## Scope

**In:** SDK-level tool_choice forcing (or in-tree wrapper, per Step 8.2's three shapes) that compels the agent to call `submit` (or `submitDiscuss` / `request_help`) before completing its turn; prompt hardening for project planner and feature plan/replan agents to make the submit-call expectation unambiguous; deterministic-LLM regression test that reproduces the original failure mode and proves the fix.

**Out:** changing the `request_help` flow; changing the proposal-host invariants; changing `decideRetry` semantics for any failure; introducing new tool variants or new run statuses.

## Background

Verified state on `main`:

- `src/agents/runtime.ts` `startPlanFeature` / `startReplanFeature` → `startProposalPhase` → `executeAgent(...)`. If the agent finishes without `submit`, `executeAgent` throws `"<phase> phase must call submit before completion"`. `src/orchestrator/scheduler/dispatch.ts` then emits `feature_phase_error`; `src/orchestrator/scheduler/events.ts` routes it through `decideRetry`, which writes inbox `semantic_failure` and sets `runStatus='failed'`.
- `decideRetry` (`src/runtime/retry-policy.ts`) classifies the resulting error against `transientPatterns` (ECONN*, ETIMEDOUT, network, 429, 5xx, rate.limit). Submit-compliance errors match none → `escalate_inbox: semantic_failure`.
- Phase 1 stops the re-dispatch loop on `runStatus='failed'`. The failure still happens; it just doesn't loop. Operator sees a failed-run icon and an inbox row.
- Real-LLM behavior observed: with the current prompt and free tool choice, the LLM sometimes returns plain text without invoking `submit`, particularly on simple inputs. The discrepancy with `fauxModel` integration tests masked the issue (faux scripts always include the `submit` call). The current `src/agents/prompts/plan.ts` already says "do not end with free-text plan" and to call `submit(...)`; the prompt is **partial**, not absent — Step 8.1 hardens an existing contract.
- **Tool_choice forwarding does not exist in the installed pi-agent-core today.** `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` shows `Agent.prompt()` and `Agent.continue()` accept no options. Resumed planner sessions go through `agent.continue()`, not just `agent.prompt()`. The underlying provider drivers (`@mariozechner/pi-ai`) expose `toolChoice` in their typings (Anthropic, OpenAI, Mistral), but `pi-agent-core` does not currently forward any `toolChoice` field through `Agent` to `streamSimple`. Step 8.2 cannot pass tool_choice "at each `agent.prompt(...)` call" against the installed SDK and must instead either (a) extend pi-agent-core upstream to forward `toolChoice`, (b) wrap/replace the `Agent` in our runtime with one that calls `streamSimple` directly with `toolChoice`, or (c) defer to a prompt-only fix in this phase and revisit when pi-agent-core grows the surface. Decide during implementation; document the choice in the commit message.
- Faux-model harness exists: `test/integration/harness/faux-stream.ts`, used by `test/integration/feature-phase-agent-flow.test.ts`. Plain-text/no-submit regression-style cases already exist in `test/unit/agents/runtime.test.ts` — Step 8.3 extends rather than starts.
- `request_help` callback wiring is the seam Phase 8 must preserve. `src/agents/tools/agent-toolset.ts` only includes `request_help` when a callback is supplied; tests confirm this in `test/unit/agents/tools/planner-toolset.test.ts`. Forcing tool-call completion (Step 8.2) must keep `request_help` in the allowed set.

## Steps

Ships as **3 commits**, in order.

---

### Step 8.1 — Prompt hardening

**What:** update the project-planner and feature plan/replan prompts to be unambiguous about the submit-call expectation. Concretely: a short, explicit paragraph at the end of the system prompt stating that the agent must call `submit` to complete its turn; that returning plain text without a tool call is treated as failure; that `request_help` is the correct tool for "I need more information" cases. Add a one-line example.

**Files:**

- `src/agents/prompts/project-planner.ts` (created in Phase 4 Step 4.1) — add submit-expectation paragraph.
- `src/agents/prompts/plan.ts` — covers both feature-plan and feature-replan (replan reuses plan's prompt). Single edit covers both phases. Existing prompt already partially asserts the contract; Phase 7 added a topology-escalation paragraph; Step 8.1 makes the submit-call expectation explicit on top of those edits.
- `src/agents/prompts/discuss.ts` — add submit-expectation paragraph. Note: discuss completes via **`submitDiscuss`**, not `submit`. The wording must reflect the per-phase tool name. (Phase 7 added the topology-escalation paragraph to this file; Step 8.1 builds on that.)
- `docs/agent-prompts/*.md` — sync the prose mirrors (`docs/agent-prompts/plan-feature.md`, `discuss-feature.md`, and the new `project-planner.md`); the `.md` files under `docs/agent-prompts/` are documentation, not the live source.
- `docs/agent-prompts/README.md` — describe the submit-call invariant.

**Tests:**

- No new tests for prompt content alone; the regression test in step 8.3 covers behavior.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify prompt hardening: (1) all four planner prompts include the submit-expectation paragraph; (2) prompts are unambiguous about plain-text completion being a failure; (3) `request_help` is identified as the correct fallback for "need more info"; (4) `docs/agent-prompts/README.md` reflects the invariant. Under 250 words.

**Commit:** `docs(agent-prompts): clarify submit-call invariant in planner prompts`

---

### Step 8.2 — Tool_choice forcing at SDK call site

**What:** force the planner agent to complete with a tool call (`submit` / `submitDiscuss` / `request_help`) instead of free text. The installed pi-agent-core does not forward `toolChoice` through `Agent.prompt()` / `Agent.continue()` today, so Step 8.2 has three viable shapes:

1. **Upstream pi-agent-core** to forward an optional `toolChoice` field from `Agent.prompt({ toolChoice })` / `Agent.continue({ toolChoice })` to `streamSimple`. Most surgical; preferred if upstream review timing allows.
2. **Replace `Agent` in our runtime** with a thin wrapper that owns the `streamSimple` call and threads `toolChoice` directly. Keeps the change in-tree but duplicates a small slice of `Agent`'s loop. Pick this if upstream is gated.
3. **Defer the SDK change** to a follow-up; ship Phase 8 as prompt + regression test only. Documented as a known gap; revisit when 1 or 2 unblocks.

Decide during implementation; document the choice in the commit message. The constraint, once wired, allows `submit` (or `submitDiscuss`) and `request_help` and disallows free-text-only turns. Both `prompt` and `continue` paths must carry it — resumed sessions go through `continue`, not `prompt`.

**Files:**

- `src/agents/runtime.ts` — at each prompt/continue call site for proposal-bearing phases (`startProposalPhase`, `startPlanFeature`, `startReplanFeature`, project-planner equivalent from Phase 4), pass tool_choice that forbids free-text completion. Resumption (`agent.continue(...)`) must carry it as well.
- `node_modules/@mariozechner/pi-agent-core/...` (if shape 1 chosen) — upstream change. Out of repo; track separately.
- `src/agents/runtime.ts` (if shape 2 chosen) — wrap `Agent` so `streamSimple` is called directly with `toolChoice`. Keep the wrapper minimal.
- `test/unit/agents/runtime.test.ts` — coverage that tool_choice is set on every prompt/continue path used by proposal phases.

**Tests:**

- Constructed agent prompt call carries the expected tool_choice value (whichever shape is chosen — assert at the boundary the runtime owns).
- Resumption (`agent.continue`) also carries the value. Regression coverage to prevent the resume path from drifting.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify tool_choice wiring: (1) `agent.prompt(...)` calls for proposal phases pass tool_choice; (2) the choice allows submit + request_help but forbids text-only completion; (3) no fork of pi-agent-core was introduced; (4) the change is isolated to proposal-bearing phases (does not affect non-proposal agent uses if any). Under 300 words.

**Commit:** `feat(agents): force tool-call completion on proposal phases`

---

### Step 8.3 — Deterministic regression test

**What:** add an integration test that reproduces the original failure mode (faux model returns plain text on a plan-phase turn) and asserts the fix. Two assertions:

- With tool_choice forcing in place, the faux model setup that produced plain text now produces an error with a clear "model returned text without a tool call" message (or equivalent SDK signal) rather than the silent skip-submit path.
- Pre-Phase-8 behavior (still reachable in test by disabling tool_choice via an opt-out) reproduces the legacy failure as a baseline; this acts as a regression anchor and is documented as such.

**Files:**

- `test/integration/feature-phase-agent-flow.test.ts` — add regression coverage for `plan` and `replan` (replan path uses the same prompt and the same toolset; covered with a thin variant of the plan test). Reuse the existing faux-model harness in `test/integration/harness/faux-stream.ts`; add a faux response that emits text only.
- `test/integration/project-planner-flow.test.ts` (new, if Phase 4 didn't already create one) — equivalent coverage for project-planner runs.
- `test/helpers/faux-responses.ts` (or existing helpers location) — add a typed helper for "plain-text-only response" that is reusable across tests.

**Tests:**

- Plain-text-only faux response from a **feature-plan** run is rejected by the SDK (or runtime wrapper) due to tool_choice; the run does not silently skip `submit`; the run lands in `runStatus='failed'` after `decideRetry` classifies the error as `semantic_failure` (Phase 1's filter then prevents re-dispatch). If Step 8.2 ships shape 3 (defer SDK), this test asserts the existing `"<phase> phase must call submit before completion"` path stays the failure mode and is **not** infinite-looped — i.e. Phase 8 ships only the prompt + regression-anchor.
- Same coverage for a **feature-replan** run.
- Same coverage for a **project-planner** run.
- Existing happy-path faux-model tests stay green.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify regression coverage: (1) faux-model plain-text response is exercised; (2) tool_choice forcing causes a typed failure rather than the silent skip-submit path; (3) coverage exists for both feature-plan and project-planner runs; (4) Phase 1's failed-filter prevents re-dispatch in this scenario; (5) faux-response helper is reusable. Under 350 words.

**Commit:** `test: regression for tool-call-required completion on planner runs`

---

## Phase exit criteria

- All three commits land in order.
- `npm run verify` passes.
- Real-LLM `/init` + `/auto` does not produce the plain-text-only failure path observed in the original investigation. Manual verification on a fresh project root: greenfield bootstrap → project planner produces a graph proposal that submits cleanly.
- The regression test fails on pre-Phase-8 code (tool_choice opt-out) and passes with tool_choice on.
- Run a final review subagent across all three commits to confirm the prompt + SDK + test fix is coherent and no failure mode is silently absorbed.

## Notes

- **Phase ordering.** Phase 8 hard-depends on Phases 1, 3, 4, and 7 (see Goal). It is **not** parallelizable with Phases 4–6 — Phase 4 must land for project-planner regression coverage, and Phase 7 must land for the prompt-edit base. The README's parallelism note has been corrected to reflect this.
- **Why prompt + tool_choice both.** Either alone is fragile. Prompt hardening alone leaves the LLM free to ignore the rule; tool_choice alone leaves the prompt ambiguous and produces poorer LLM reasoning. Together they make the contract explicit and enforced.
- **Shape 3 ships incomplete.** If Step 8.2 picks Shape 3 (defer SDK), Phase 8 ships only the prompt + regression-anchor and the LLM-side failure mode is reduced but not eliminated. The phase exit criterion "real-LLM /init + /auto does not produce the plain-text-only failure" is then a **best-effort** assertion rather than a hard gate; a follow-up phase must complete the SDK side. Document this clearly in the commit message and exit notes if Shape 3 is chosen.
- **No retry-policy change.** This phase does not reclassify any error. `decideRetry` is **not** modified by Phase 8 — submit-compliance failures continue to classify as `semantic_failure` and escalate to `runStatus='failed'`. Phase 1's filter prevents the loop. The Scope/Background mention of `decideRetry` is descriptive (current behavior reference), not deliverable.
- **Real-LLM verification.** The commit-level review subagent should run the test suite. A separate manual smoke against a real Claude model on a fresh project root is recommended as a final gate before declaring the phase exit criteria met.
