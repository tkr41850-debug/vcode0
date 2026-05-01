# Concern: Concurrent Project-Planner Sessions

## Concern

The project planner is a top-level (project-scope) agent the user can invoke ad-hoc to mutate graph topology (milestones, features, inter-feature dependencies, feature specs). Sessions are persistent and the user can switch between them in the TUI. No lock prevents two project-planner sessions from running simultaneously and proposing overlapping or conflicting topology changes.

If session A submits a proposal while session B has an unsubmitted draft over the same graph regions, session B's proposal — when it later submits — may target features/milestones/edges whose state changed under A's apply.

## Why to Watch

In practice we expect a single user driving one project-planner session at a time, so this is unlikely to manifest in normal use. The decision is to **not enforce a single-instance lock** at this stage and instead handle conflicts at apply time, treating the second proposal like a git merge against the now-updated baseline. This keeps the planner UX simple and avoids prematurely modeling project-scope locking.

The risk surfaces if:

- Operator spawns multiple TUI sessions or otherwise drives concurrent planner runs.
- An automated escalation path (e.g. feature planner emitting `topology_request` inbox items) ever auto-spawns project planner runs in parallel with a human-driven session.
- Resumed/recovered planner sessions reapply old proposals against a graph that has moved on.

## What to Observe

- Multiple `agent_runs` rows with `scope_type='project'` in `running` or `await_approval` simultaneously.
- Approval-time validation rejections citing missing/stale feature or milestone IDs.
- Inbox items of kind `topology_request` arriving while a user-driven project-planner session is already active.

## Current Position

- Allow concurrent project-planner sessions; do not gate at run start.
- At apply time, validate each proposal against current authoritative state (CAS-style): if any referenced feature/milestone/edge has changed in a way that invalidates the recorded mutation sequence, reject the apply with a structured rebase reason and surface to the user.
- The user can then re-open that session, see the rebased baseline, revise, and resubmit.
- Treat this as the "second proposal rebases on the first" model rather than a hard serialization barrier. No project-scope merge train at this stage.
- Re-evaluate if observation shows frequent rebase rejections or auto-escalation paths producing collisions.

## Implementation Status

The CAS-style apply described above is the **target behavior** introduced by Phase 4 of `docs/implementation/02-project-planner`. On `main` today, the apply path (`approveFeatureProposal` → `applyGraphProposal`) does per-op stale-skip validation rather than whole-proposal CAS rejection: individual ops that no longer apply cleanly are skipped, and the apply continues with the remaining ops. There is no structured rebase reason and no session re-open. Phase 4 Step 4.4 introduces the CAS mode for project-scope proposals; feature-scope proposals continue to use the existing per-op behavior.

## Related

- [Architecture / Planner](../architecture/planner.md)
- [Architecture / Graph Operations](../architecture/graph-operations.md) — feature-branch merge-train serialization (different scope, same conceptual pattern).
