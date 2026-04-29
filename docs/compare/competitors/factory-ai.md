# Comparison with Factory.ai

Snapshot taken on 2026-04-28 from public Factory.ai materials only ([factory.ai](https://factory.ai/)). This is a high-level product comparison against the public website, blog posts, and 2026 funding coverage, not a deep code audit. Worth revisiting as both projects evolve — Factory is moving fast post-Series C.

## Why this comparison matters

Factory.ai is **the closest enterprise-commercial competitor to gvc0's overall shape**. Like gvc0, it decomposes a spec into a coordinator + specialized workers, runs them in parallel, and treats software delivery as the unit of work — not single-file edits or per-PR suggestions. Series C of $150M at $1.5B valuation (2026-04-16, Khosla-led) makes them the most-funded direct competitor in the coordinator-plus-specialists shape.

Customers cited publicly include MongoDB, EY, Bayer, and Zapier — i.e. enterprise rollouts, not individual-developer adoption.

## Summary

Factory and gvc0 share architectural intuitions but diverge on **what's authoritative**:

- **Factory** appears to be a coordinator-driven SaaS where specialized droids (planning, coding, review, deployment) run as managed services. The state model and merge semantics are not publicly specified.
- **gvc0** is a self-hosted DAG-orchestrated delivery system with explicit invariants (DAG dependency-shape, merge-train, split state, typed verification). Its state model is documented and inspectable.

The conceptual mapping is approximate:

- Factory **coordinator** ≈ our **scheduler + planner**.
- Factory **specialized droid** ≈ our **task worker** or **replanner**, depending on role.
- Factory **delivery flow** ≈ our **feature lifecycle from plan to merge**.

Factory does not publicly formalize feature-only-on-feature / task-only-within-feature dependency constraints, nor a programmatic merge train, nor a split state model. They may exist internally; this comparison reflects what is documented or surfaced.

## Feature mapping

| Public Factory.ai feature | Our architecture | Notes |
|---|---|---|
| Coordinator agent decomposes work into droids | Planner produces proposal-graph; scheduler dispatches feature/task work | Both have a top-level decomposer. Factory's coordinator output shape is not publicly specified; ours is a typed proposal graph with HITL approval. |
| Specialized droids per role (planning, coding, review, deploy) | Planner / replanner / task worker / verify | Roles overlap. Factory exposes deployment as a droid role; we stop at merge into `main`. |
| Parallel droid execution | Process-per-task workers in worktrees | Both parallelize. We document the worktree + IPC mechanics; Factory's execution substrate is not publicly specified. |
| "Full SDLC including deployment" | Out of scope for gvc0 (we end at merge) | Factory extends into release/deploy; gvc0 deliberately stops at the merge boundary. |
| Enterprise security / compliance posture | Not directly comparable | Factory's enterprise positioning includes SOC2 / governance; gvc0 is a self-hosted CLI. |
| HITL handoff at major decisions | Proposal-graph approval before mutation | Both have HITL; ours is a structured proposal artifact, theirs is a UI handoff. |
| Auto-resume after long-running tasks | Crash recovery via SQLite + git refs authoritative | Both have crash recovery; ours is documented invariant-driven, theirs is managed-service opaque. |
| No publicly specified merge train | Programmatic merge train (rebase → CI → SHA validation → merge --no-ff) | gvc0's distinguishing axis. |
| No publicly specified DAG-as-state | Long-lived milestone → feature → task DAG | gvc0's distinguishing axis. |
| No publicly specified split state model | work_control / collaboration_control / run-state | gvc0's distinguishing axis. |
| No publicly specified typed-issue verification | Typed `VerifyIssue` with sourced classification | gvc0's distinguishing axis. |
| Multi-model / budget governance (likely) | Heavy / standard / light + ceilings | Both likely have it; ours is documented, Factory's not surfaced. |

## Where Factory looks stronger

1. **Enterprise integration breadth.** Identity, SSO, audit, governance — Factory is positioned as enterprise-ready in a way gvc0 is not (and does not aim to be at this stage).
2. **Deployment scope.** Factory's "full SDLC including deployment" extends past where gvc0 stops. Whether that's a feature or a scope creep depends on the user.
3. **Funding and team scale.** $150M Series C means Factory can sustain product development at a different velocity than a self-hosted OSS project.
4. **Customer references.** MongoDB / EY / Bayer / Zapier are concrete enterprise rollouts. gvc0 has no comparable public customer story (and isn't trying to).
5. **Product polish on the user surface.** Web UI + managed service experience is more accessible than a self-hosted TUI for many user populations.

## Where gvc0 remains differentiated

1. **Self-hostability.** gvc0 runs locally with self-managed git, SQLite, and worktrees. Factory is a managed service.
2. **Inspectable invariants.** gvc0's DAG dependency-shape constraints, merge-train invariant chain, and split state model are all documented and enforceable from the codebase. Factory's are not surfaced publicly.
3. **Programmatic merge train.** Factory has not publicly specified a serialized integration train into `main`. gvc0 has the rebase → post-rebase CI → main-SHA validation → `merge --no-ff` chain as a documented invariant.
4. **Long-lived authoritative DAG-as-project-state.** Factory's coordinator output may be ephemeral per-run; gvc0's DAG is the project's source of truth across runs and survives crashes.
5. **Typed verification routing.** `VerifyIssue` discriminated union driving the replanner is gvc0-unique.
6. **Cross-feature primary/secondary policy.** No public Factory equivalent.
7. **Boundary discipline.** `core/` (pure) → `orchestrator/` (service) → adapters is a documented architectural constraint. Factory's internal boundaries are not surfaced.

## Where we still trail or differ

1. **Enterprise-grade operator surface.** No web dashboard, no SSO, no audit log. Not an immediate goal, but it's the largest functional gap.
2. **Deployment scope.** Factory extends past merge; we stop at merge. Justifiable scope choice but worth naming.
3. **Customer story / case studies.** Factory has them; we don't (yet). For positioning purposes, a case-study page would be valuable if any team adopts gvc0 at scale.
4. **Public benchmarks.** Factory's marketing leans on benchmark performance (publicly cited but not always rigorously attributed). gvc0 has none.

## Strategic notes

- Factory is the most-funded entity in the coordinator-plus-specialists shape. If gvc0 wants to position vs. Factory, the differentiator pitch is roughly: *self-hosted, inspectable invariants, programmatic merge train, DAG-as-state.* That's a credible four-bullet list against a managed-service offering.
- The fastest way to lose differentiation is for Factory to publish a specification of their coordinator's state machine. Worth re-checking their engineering blog quarterly.
- Factory's customer mix (MongoDB, EY, Bayer, Zapier) suggests they're winning on enterprise procurement, not on architectural sophistication. gvc0's audience is closer to "engineering teams who want their merge boundary defended by an inspectable invariant chain" — a smaller but well-defined population.

## Public references

- <https://factory.ai/>
- <https://tech-insider.org/factory-ai-150-million-series-c-khosla-coding-droids-2026/>

## Revisit notes

This comparison is worth revisiting after:

- Factory publishes a specification of their coordinator's state model or droid handoff contract.
- Factory documents a serialized integration / merge-coordination story.
- Factory adds dependency-shape constraints (or relaxes them) in their planner.
- gvc0 ships any operator surface (web dashboard, SSO, audit log) that closes the enterprise gap.
- A case study emerges of gvc0 in production at scale.

## Adoption status

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| Enterprise-grade operator surface — web dashboard, SSO, audit log | open | — | Largest functional gap vs. Factory; not an immediate goal per the doc. No feature-candidate exists yet. |
| Deployment scope — extend past merge into release/deploy | deferred | — | Intentional scope boundary: gvc0 deliberately stops at merge into `main`. Not a gap to close. |
| Customer story / case studies — publish a case-study page when a team adopts gvc0 at scale | open | — | Prerequisite is a production adopter; nothing to act on until then. |
| Public benchmarks — publish performance benchmarks comparable to Factory's marketing claims | open | — | No internal benchmark harness yet. Low priority relative to core correctness work. |
| Re-check Factory engineering blog quarterly for state-machine specification disclosure | open | — | Standing monitoring task; no commit mechanism needed until Factory publishes something actionable. |
