# Feature Candidate: User Feature Kill

## Status

Future feature candidate. Not part of baseline scope.

## Baseline

Two feature-removal primitives exist, asymmetric in scope and policy:

- **`cancelFeature`** is the user-facing soft abort. TUI key `x` / slash `/cancel` → `cancelSelectedFeature` in `src/tui/app-command-context.ts` → `cancelFeatureRunWork` in `src/compose.ts` → `graph.cancelFeature`. Preserves feature, tasks, and worktrees; sets `collabControl = 'cancelled'`; aborts in-flight task runs and agent runs. Graph state survives for inspection and restore; in-flight runs themselves are terminated, not suspended.

- **`removeFeature`** is the destructive primitive in `src/core/graph/feature-mutations.ts`. It is reachable in production only via proposal approval (`applyProposalOp` in `src/core/proposals/index.ts`). The proposal layer refuses to remove a feature that has already started work or still has dependents (`staleReasonForOp`). There is no user-facing path that calls `removeFeature` directly, and the core mutation itself has no guard and no runtime cleanup (worktrees, agent runs) — the policy lives at the proposal boundary.

Net effect: a user who decides that a started feature should be wiped entirely (not just cancelled-in-place) has no supported workflow. The soft cancel leaves the feature visible in state with cancelled status; proposals from the planner/replanner will refuse to remove it.

## Candidate

Introduce a user-initiated destructive kill flow:

- TUI surface: a distinct command (e.g. `/feature-kill` or `x` with a `--hard` modifier) that pops a confirmation modal listing:
  - in-flight task runs and agent runs to be aborted;
  - worktrees to be removed;
  - dependent features that will lose their upstream edge.
- On confirm, orchestrator path executes atomically:
  1. Abort in-flight task runs and agent sessions (reuse `cancelFeatureRunWork`).
  2. Remove task and feature worktrees via `runtime.worktree`.
  3. Call `graph.removeFeature` — bypassing the proposal-layer started/dependents guard because this is explicit user intent, not planner inference.
  4. Emit a `feature_killed` audit event capturing who/when/what.
## Related

Today's soft cancel path has its own UX gap: `cancelSelectedFeature` fires with no confirmation even though it aborts in-flight task runs. A "work has started on feature X" confirmation (when any task is not `pending` / `done` / `cancelled`) is a smaller, independent change that could land before or alongside the kill flow and share the confirmation UI.

## Why Deferred

- Destructive UX needs careful design (confirmation copy, undo surface, audit trail).
- Worktree cleanup ordering interacts with merge-train (if the feature is already in the merge queue) and the replanner (if a replan is in-flight).
- Overriding the proposal-layer policy from a separate entry point introduces a second code path for destructive state mutation; both paths must stay coherent.
- The existing cancel path is reversible and sufficient for most operator flows; hard-kill is a lower-frequency need.

Until then, operators should use `cancelFeature` to stop work; hard removal of a started feature requires direct DB intervention and is not part of the supported surface.
