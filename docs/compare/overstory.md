# Comparison with Overstory

Snapshot taken on 2026-04-28 from public Overstory materials only ([github.com/jayminwest/overstory](https://github.com/jayminwest/overstory)). This is a high-level product comparison against the public README and repo structure, not a deep code audit. Worth revisiting as both projects evolve.

## Why this comparison matters

Overstory is **the closest direct architectural analogue to gvc0** that surfaced in the 2026-04 landscape survey. It's the only OSS product that publicly treats a programmatic merge train into `main` as a core orchestration primitive — which is the property that everyone else (Devin, Factory, OpenHands, Cursor) leaves to GitHub Merge Queue / Mergify / Graphite. If gvc0 has prior art in this space, Overstory is it.

## Summary

Overstory and gvc0 both target *autonomous parallel agents that merge into main without breaking it*. The core building blocks overlap:

- **tmux + git-worktree workers** instead of gvc0's child-process + worktree workers.
- **FIFO SQLite-backed merge queue** instead of gvc0's serialized merge train.
- **4-tier conflict resolution** instead of gvc0's same-feature locks + cross-feature primary/secondary policy.

The main difference is **what's the long-lived authoritative state**: Overstory tracks queue position and worker assignment; gvc0 tracks a milestone → feature → task DAG with explicit dependency-shape constraints (feature-only-on-feature, task-only-within-feature). Overstory is closer to a "merge queue with workers" — gvc0 is a "DAG-orchestrated delivery system that happens to merge through a queue."

Conceptual mapping (approximate):

- Overstory **worker** ≈ our **task worker** (both run in worktrees).
- Overstory **merge queue entry** ≈ our **feature collaboration_control state** approaching `merging`.
- Overstory **conflict tier** ≈ our **conflict-coordination policy** (same-feature vs. cross-feature).
- Overstory has no clear analogue of our **milestone/feature/task DAG** as a planning artifact.

## Feature mapping

| Public Overstory feature | Our architecture | Notes |
|---|---|---|
| FIFO SQLite-backed merge queue | Serialized merge train into `main` | Both serialize integration. Ours pairs with explicit rebase → post-rebase CI → main-SHA validation → `merge --no-ff` invariant chain; Overstory's exact CI sequence not yet read in detail. |
| 4-tier conflict resolution | Same-feature write-path locks + cross-feature primary/secondary | Closest functional match in the field. Worth comparing tier semantics line-by-line with our policy. |
| tmux + worktree workers | Child-process + worktree workers + NDJSON IPC | Mechanically similar; gvc0's transport is structured stdio rather than terminal multiplexing. |
| SQLite as queue store | SQLite via better-sqlite3, git refs authoritative | Both lean on SQLite for durability; both must reconcile against git. |
| No public DAG planner | Milestone → feature → task DAG | gvc0's distinguishing axis. |
| No public proposal-graph approval | Proposal-graph planner with HITL approval before mutation | gvc0's distinguishing axis. |
| No public split-state model | work_control / collaboration_control / run-state | gvc0's distinguishing axis. |
| No public typed-issue verification payload | Typed `VerifyIssue` with `verify | ci_check | rebase` source | gvc0's distinguishing axis. |
| No public dedicated replanner agent | Replanner agent for verify-failure recovery | gvc0's distinguishing axis. |
| No public budget routing tiers | Heavy / standard / light routing + ceilings | gvc0's distinguishing axis. |

## Where Overstory looks stronger or simpler

1. **Conceptual minimalism.** Overstory's surface is roughly "queue + workers + conflict tiers." That's easier to reason about, easier to onboard, and easier to operate than gvc0's split state model. Worth borrowing the framing for any user-facing explanation of gvc0's merge train.
2. **Public design-space disclosure.** The conflict-tier rules are documented as a numbered policy. gvc0's same-feature/cross-feature rules are documented across multiple operations pages and would benefit from a similar single-page numbered policy.

## Where gvc0 goes beyond Overstory

1. **Persistent project DAG as authoritative state.** Our milestone/feature/task graph survives across runs; Overstory's queue is per-run state, not project state.
2. **Dependency-shape constraints.** Feature-only-on-feature and task-only-within-feature are enforced at graph-mutation time in `core/graph`. Overstory does not publicly enforce dependency shape.
3. **Split state model.** `work_control` vs. `collaboration_control` vs. run-state is gvc0's clearest moat for crash recovery and re-planning correctness. Overstory's queue + worker model collapses these.
4. **Typed verification routing.** `VerifyIssue` discriminated union with `verify | ci_check | rebase` source feeds the replanner; Overstory's recovery semantics on tier-3/tier-4 conflicts are not yet read but appear to be tier-local rather than agent-driven.
5. **Proposal-graph + human approval.** Authoritative graph mutation only happens after operator accepts a proposal. Overstory does not have a planner agent in the same sense.
6. **Cross-feature primary/secondary policy.** The asymmetric coordination across long-lived feature branches has no clear Overstory analogue.

## Where we still trail or differ

1. **Operator-facing simplicity.** A single "queue + workers + tiers" mental model is easier to explain than gvc0's three-axis state model. We'd benefit from a similar one-pager.
2. **Conflict-tier disclosure.** Overstory's tiered conflict-resolution rules are numbered and public. Our same-feature lock + cross-feature primary/secondary policy is split across operations docs and would be clearer in a single numbered policy page.
3. **No publicly-confirmed cross-feature comparison.** Without reading Overstory's actual tier semantics in detail, we can't confirm whether tier 3 / tier 4 is materially different from gvc0's primary/secondary policy. This is the highest-payoff follow-up.

## Recommended follow-up reading

In rough order of payoff:

1. Read Overstory's **conflict-tier source code** to understand whether tier 3 / tier 4 corresponds to anything like our primary/secondary policy. If yes, cite Overstory in `docs/operations/conflict-coordination.md` as prior art. If no, document the gap.
2. Read Overstory's **queue → CI → merge sequence** to see whether they validate against `main`'s SHA the way we do, or whether they assume the queue itself is the linearization point.
3. Read Overstory's **SQLite ↔ git reconciler** (if one exists) to compare with gvc0's startup reconciler. Both projects depend on git refs being authoritative; the question is how each handles divergence.
4. Look for any **dependency-shape tracking** in Overstory's source — even informal feature-task grouping would be relevant to compare against our DAG constraints.

## Public references

- <https://github.com/jayminwest/overstory>

## Revisit notes

This comparison is worth revisiting after:

- Reading Overstory's conflict-tier source in detail (currently summarized from README/repo metadata only).
- Either project publishes a dedicated merge-train spec page.
- Overstory adds (or surfaces) a planner / DAG / dependency-tracking layer.
- gvc0 promotes its merge-train invariant chain to a dedicated topic page.
