# Tool-choice forcing for planner agents (deferred)

## Status

Deferred. Phase 8 of `docs/implementation/02-project-planner/` ships the
prompt-side hardening (Step 8.1) and a regression anchor (Step 8.3) but does
not wire SDK-level tool forcing.

## Context

Planner agents (project-planner, feature plan/replan, discuss) must complete
every turn with a tool call. Phase 1's failed-run filter already prevents
re-dispatch loops on `runStatus='failed'` when an agent ends with plain text:
`decideRetry` (`src/runtime/retry-policy.ts`) classifies the resulting
"<phase> phase must call submit before completion" as `semantic_failure`,
which the scheduler does not retry.

The remaining gap is: even when the prompt and the failed-run filter are
both correct, an LLM that is "trying" to behave can still emit prose-only
turns that waste an entire run. SDK-level tool forcing (`tool_choice` =
`required` or named) would prevent the prose-only emission at the API
layer instead of recovering from it post-hoc.

## Why deferred

`pi-agent-core` is the upstream agent loop in use today. As of the time of
this note, `Agent.prompt(...)` and `Agent.continue(...)` accept no
`toolChoice` option (verified in
`node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`). Three shapes
were considered for closing the gap:

1. **Upstream change in pi-agent-core** to thread `toolChoice` through to
   the underlying provider call. Cleanest, but gated on upstream
   acceptance and release cadence.
2. **Wrap `Agent` in-tree** to drive a custom loop that injects
   `tool_choice` per provider. Duplicates non-trivial Agent loop logic
   (retries, tool dispatch, message accumulation) in this repo.
3. **Defer.** Rely on prompt clarity (Step 8.1) plus the failed-run filter
   (Phase 1) plus a regression anchor (Step 8.3) to bound the blast radius
   to one wasted run per offence.

Shape 3 was chosen for Phase 8. The cost of an occasional prose-only
planner turn is one wasted run, surfaced as a `semantic_failure` inbox
row; this is not silent and not loop-forming.

## What it would take to ship

Pick Shape 1 or Shape 2:

- **Shape 1**: open an upstream PR on `pi-agent-core` that adds
  `toolChoice` to `Agent.prompt`/`Agent.continue` options and forwards it
  to the provider. Then update `src/agents/runtime.ts` (and any feature
  phase entrypoints) to pass `toolChoice: { type: 'required' }` (or
  `{ type: 'tool', name: 'submit' | 'submitDiscuss' }`) on the final turn
  of each planner phase.
- **Shape 2**: add a thin wrapper around `Agent` under `src/agents/` that
  exposes a `promptWithRequiredTool(...)` surface backed by a custom loop.
  Migrate planner-phase entrypoints to the wrapper.

In either case, add a positive integration test that the SDK call fails
fast with a tool-call when the model attempts to emit a prose-only turn,
rather than relying on the failed-run filter to clean up after the fact.

## Pointers

- Live planner prompts: `src/agents/prompts/{project-planner,plan,discuss}.ts`
- Failed-run filter: `src/runtime/retry-policy.ts` (`decideRetry`,
  `semantic_failure` classification)
- Phase 8 spec: `docs/implementation/02-project-planner/phase-8-submit-compliance.md`
- Regression anchor: `test/integration/feature-phase-agent-flow.test.ts`
  (plan and replan plain-text-only cases added in Step 8.3)

## Project-planner regression coverage gap

Step 8.3's spec asks for matching coverage of project-planner runs. That is
not landed: project-planner integration through `LocalWorkerPool` requires
a `projectPlannerBackend` and a `ProjectPlannerAgentSessionFactory` adapter
that are not wired in `src/compose.ts` today. The submit-call check
(`<phase> phase must call submit before completion`) lives in
`FeaturePhaseOrchestrator.startProposalPhase` and is reached only through
that wiring. Closing this gap is a Phase-4 follow-up that should add the
factory/backend wiring and an integration regression matching the
plan/replan cases. Until then, project-planner relies on shared prompt
hardening (Step 8.1) and the failed-run filter; the failure signature is
structurally identical to feature-plan because both use `executeAgent` with
phase `'plan'`.
