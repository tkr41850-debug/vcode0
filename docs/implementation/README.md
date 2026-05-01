# Implementation Tracks

Milestone-scale plans, organized as **tracks**. Each track is a directory with its own README that owns global phase ordering and a set of `phase-<N>-<slug>.md` docs.

Phase docs are the executable plan: Contract (frozen at start) + Plan (mutable) + numbered Steps (commit-sized, each with a verbatim conventional commit subject and review goals).

## Authoring

- [Phase Doc Guidelines](./guidelines.md) — canonical structure, header fields, tiered step template, sizing rubric, glossary convention, closing checklist. Applies to phase docs authored after the guidelines were introduced; existing docs are not retroactively migrated.
- [Phase Doc Example](./guidelines-example.md) — synthetic 2-step worked example covering Standard and Heavy tier shapes end to end.

## Tracks

- [01-baseline](./01-baseline/README.md) — MVP hardening for the single-orchestrator runtime. Ports back architectural advances proven on the `gsd` branch, scoped to the minimum needed for a shippable MVP. Nine phases.
- [02-project-planner](./02-project-planner/README.md) — Top-level project planner agent, feature-planner scope split, agent-driven bootstrap, persistent project-planner sessions in the TUI. Assumes 01-baseline merged. Eight phases.
- [03-distributed](./03-distributed/README.md) — Lift the runtime from local-machine process-per-task to a fleet of remote workers reachable over the network. Wire planes, leases, recovery, deployment packaging. Assumes 01-baseline merged. Eight phases (0–7).

Each track README is the source of truth for ordinal sequence within that track. Phase numbers within a track are stable identities, not ordinal claims — track READMEs may ship phases out of numeric order.
