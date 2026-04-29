# Feature Candidate: Cross-Family Replanner

## Status

Future feature candidate. Highest-leverage finding from the [2026-04-29 deep-dive synthesis](../../compare/landscape/2026-04-29-deep-dive-synthesis.md).

## Baseline

Today the planner agent and the replanner agent share a model family by default. The model router (`heavy / standard / light` tiers) selects within a single family configured per gvc0 install. There is no architectural rule preventing the same model family from being used for both roles, and no defaults that diverge them.

## Candidate

Pin the replanner to a different model family than the planner, configurable but with a non-same-family default.

```ts
// Sketch — actual surface lives in src/orchestrator/model-router.ts
interface ModelRouterConfig {
  planner: { family: 'anthropic' | 'openai' | 'google' | ...; tier: 'heavy' | 'standard' };
  replanner: { family: 'anthropic' | 'openai' | 'google' | ...; tier: 'heavy' | 'standard' };
  // Default: planner.family !== replanner.family.
  // Validation: warn (not error) when they match, with a flag to suppress.
}
```

## Why It Matters

arXiv 2604.19049 measures correlated review blind spots across same-family LLMs and reports cross-family review catching roughly 16% additional issues. The correlation strengthens with model capability — meaning the problem gets worse, not better, as models improve.

For gvc0 the replanner is unusually load-bearing on whether the next iteration converges:

- The replanner sees only verify failures. Its decisions about what to retry, what to redesign, and what to escalate are made on a narrow context.
- A planner-and-replanner sharing blind spots will iterate into the same dead end. Cross-family disagreement is the empirical signal that pulls the loop out of dead ends.
- The cost of a dead-end iteration is high: full task respawn, full verify rerun, possibly full feature rewind.

This is the smallest change in the synthesis with the largest expected quality lever. The wiring is config-level; the empirical evidence is published; the failure mode it prevents is one of the most expensive in the orchestrator.

## How It Would Be Implemented

1. Extend `ModelRouterConfig` with a `replanner` slot independent of `planner`.
2. Add a default: when not configured, infer a non-same-family replanner from the available providers. If only one family is configured, warn at startup and fall back to same-family with a clear log line.
3. Per-call routing in `src/orchestrator/scheduler/replanner-dispatch.ts` resolves the replanner family at dispatch time, not at agent-run creation time, so a config change applies to in-flight features on next replan.
4. Update `src/agents/replanner/prompts/*` if any prompt language is family-specific (e.g., tool-call quirks). Likely minimal; the prompts are model-agnostic by design.
5. Persistence: `agent_runs.model_family` already exists; cross-family replanners just populate it with a different value. No migration needed.
6. Integration test: a `fauxModel`-driven scenario where the planner and replanner respond to the same verify-failure payload differently, confirming the orchestrator routes to the configured replanner family rather than re-using the planner's session.
7. Telemetry: emit a `replanner.family_match` event flagging same-family runs (for users who explicitly opted in) so the impact is measurable.
8. Documentation: update `docs/architecture/agents.md` (or equivalent) to describe the cross-family default and the empirical citation.

## Why Deferred

- Cross-family routing presumes the user has configured at least two model families. Many gvc0 installs today are Claude-only. The default needs a graceful fallback before this can ship.
- Empirical lift on the gvc0-specific verify-failure recovery rate has not been measured locally; only the published cross-family review benchmark is cited. Worth establishing a baseline before declaring victory.
- Prompt language for the replanner may need light family-specific tuning, which surfaces only after running both families end-to-end.

## When to Promote

Promote from candidate to baseline when:

- gvc0 has at least one supported non-Anthropic model family wired through the harness (today's baseline harness supports more than one family in principle but is exercised primarily with Anthropic models).
- A measured experiment shows cross-family replanner reduces verify-failure-to-merge cycle count on a realistic benchmark suite, confirming the published cross-family review finding generalizes to gvc0's specific failure-recovery shape.
- Default-fallback behavior for single-family installs is operationally sound (warning vs. fall-through).

## Public references

- arXiv 2604.19049 — same-family LLM review blind spots.
- Synthesis: [2026-04-29 deep-dive](../../compare/landscape/2026-04-29-deep-dive-synthesis.md), finding #2.
- Topic page: [verification-architectures.md](../../compare/research/verification-architectures.md).

## Notes Carried Forward From Design Discussion

- Cross-family planner-vs-task-worker was considered and rejected as a first move: task workers see much richer context than the replanner and the same-family blind-spot signal is weaker for them. Replanner is the targeted lever.
- Forcing cross-family was considered and rejected: prefer warn-with-default-divergence over hard error so single-family installs stay usable.
- Considered emitting cross-family runs as a separate `agent_runs.kind` value; rejected as over-fitting. The family is already on the row.
