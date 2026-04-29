# Feature Candidate: `absurd` Evaluation

## Status

Evaluation candidate (not an implementation candidate). Surfaced from the [2026-04-29 deep-dive synthesis](../compare/2026-04-29-deep-dive-synthesis.md).

This entry tracks an investigation, not a planned change. Promoting to a baseline change requires the evaluation to land first.

## Baseline

gvc0's state model:

- **Authoritative**: git refs (branches, worktrees, merge state). The merge train operates on git directly; recovery semantics fall out of `git status` + the persisted task table.
- **Derived bookkeeping**: SQLite via `better-sqlite3`. Tables for `agent_runs`, `tasks`, `features`, events, and scheduling state.
- **Transport**: NDJSON over stdio between orchestrator and worker subprocesses.

There is no dedicated durable-execution engine. Crash recovery is a startup reconciler that reads git + SQLite and reconstructs in-memory orchestrator state.

## Candidate

Evaluate Earendil's `absurd` (Postgres-native durable workflow engine for Pi agents) as a complement — not a replacement — for the orchestrator's *internal scheduling state*. Specifically:

- Graph state stays git-authoritative. Not negotiable.
- Worker outputs (squash-merge + verify-issue payload) stay git + SQLite. Not negotiable.
- The question: does `absurd` improve the *scheduler's own* in-flight bookkeeping (which task is being dispatched, retry/backoff state, in-flight feature-phase runs, suspend/resume state) without compromising the git-authoritative property elsewhere?

## Evaluation Questions

1. **API fit.** Does `absurd`'s workflow-and-step model map cleanly to gvc0's "feature-phase run" or "task worker run" granularity? Or is the impedance mismatch large enough that adopting it requires reshaping gvc0's scheduling boundary?
2. **State boundary.** Can `absurd` host scheduler state (which run is dispatched, who's waiting on what) while gvc0 keeps graph state in git + SQLite? Or does `absurd` want to own "everything that durably persists"?
3. **Crash semantics.** When the orchestrator crashes mid-dispatch, does `absurd` give cleaner recovery than the current startup reconciler? Or is the win marginal because git refs already encode most recoverable state?
4. **Operational footprint.** Postgres-native means a Postgres dependency. Today gvc0 ships with embedded SQLite and zero external services. The operational delta is real and needs honest accounting.
5. **License compatibility.** `absurd` is part of Earendil's commercial product surface and may ship under fair-source DOSP. `pi-agent-core` (gvc0's actual dependency) is MIT-permanent under RFC 0015, but `absurd` may not be. Worth confirming before adopting.
6. **Migration path.** If `absurd` is adopted later, what does the migration look like? Is there a reversible adoption (run both, dual-write, cut over) or is it one-way?

## Why It Matters

`absurd` is the most interesting deliverable from the post-Earendil ecosystem because:

- It's built by the same people who maintain `pi-agent-core`. Impedance mismatch with pi-sdk semantics is likely lower than with Temporal / Restate / Inngest / DBOS.
- It targets agent-shaped workflows specifically (long tool calls, in-flight steering, retry-with-modified-context).
- Postgres-native is a known operational substrate; no new ops surface to learn.

The synthesis recommends a sprint of evaluation, not adoption. The downside scenario is "we evaluate, conclude the impedance is wrong or the operational footprint is unjustified, and document why we declined." That's a useful artifact even if the answer is no.

## How the Evaluation Would Run

1. **Install + run examples.** Bring `absurd` up against a local Postgres; walk through its tutorial workflows. Establish baseline familiarity.
2. **Map gvc0 scheduler state to `absurd` primitives on paper.** Identify which gvc0 entities map to `absurd` workflows, which map to steps, and which don't fit.
3. **Build a throwaway proof-of-concept** for one narrow surface: dispatch + retry/backoff for a single feature-phase run. Not integrated; isolated.
4. **Measure**: lines of code (gvc0 retains this state today; what does `absurd` save?); recovery semantics on simulated crash; operational complexity.
5. **Decide**: write up findings as a regular `docs/compare/` page with a clear recommendation (adopt, reject, partial-adopt, defer-pending-X).

## Why Deferred (until evaluated)

- The current state model works. Crash recovery is exercised in integration tests; the merge train is invariant-protected. There is no acute pain that adopting `absurd` would relieve.
- Postgres dependency is a real operational tax that single-developer or small-team installs would feel acutely.
- `absurd` is pre-1.0 public preview. API stability is not promised. Adopting now risks a forced migration when v1 lands.
- The git-refs-authoritative property is gvc0's strongest moat. Anything that risks splitting authority between git and another store is high-stakes.

## When to Promote (the evaluation, not the adoption)

The evaluation itself is worth running when:

- `absurd` reaches a v1 candidate or beta with a documented API stability commitment.
- A concrete pain point in gvc0's scheduler state emerges that the current SQLite + reconciler model handles awkwardly.
- A community signal (other Pi-sdk-based projects adopting `absurd`) raises confidence in API maturity.

Adoption (a separate decision) requires the evaluation to land with a clear recommendation, plus user input on the Postgres-dependency cost.

## Public references

- Earendil `absurd`: <https://earendil.dev/absurd/>
- RFC 0015 (licensing): <https://earendil.dev/rfcs/0015-licensing.md>
- Topic pages: [durable-execution.md](../compare/durable-execution.md), [pi-ecosystem-post-earendil.md](../compare/pi-ecosystem-post-earendil.md).

## Notes Carried Forward From Design Discussion

- Considered evaluating Temporal instead. Rejected as first move: higher impedance mismatch (Temporal isn't agent-shaped), higher operational footprint, no shared author with pi-sdk. `absurd` is the closest match; if `absurd` doesn't fit, Temporal almost certainly doesn't either.
- Considered evaluating LangGraph for the same role. Rejected: LangGraph's checkpointing is between-step only, which is *worse* than gvc0's current model for in-flight tool calls. See [durable-execution.md](../compare/durable-execution.md).
- Considered adopting `absurd` for graph state too. Rejected without further investigation: the git-refs-authoritative property is non-negotiable; splitting authority is the failure mode to avoid.
