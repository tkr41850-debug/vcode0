# Feature Candidate: Verify Nit Task Pool

## Status

Future feature candidate. Not part of baseline scope.

## Baseline

The verify agent raises typed `VerifyIssue[]` via `raiseIssue({severity, description, location?, suggestedFix?})` during the verify phase. Severity is one of `blocking`, `concern`, `nit`.

Current routing:

- `blocking` or `concern` → feature work control moves to `replanning`; the replanner consumes `verifyIssues` and proposes the next task set.
- `nit` → non-blocking. Issue is persisted onto `features.verify_issues` and surfaced in the verification summary (returned by `submitVerify`), but does not force `replan_needed`. The feature can still move to `awaiting_merge`.

Rationale: blocking merge on nits would either collapse the severity tier (every nit = replan cycle, so nits collapse to concerns) or pressure the verifier to suppress low-signal findings to unblock merge. Keeping nits non-blocking preserves the signal.

## Candidate

Accumulated nits currently live on `features.verify_issues` and have no post-merge destination. A future feature could introduce a pool of task-candidates seeded from nits across features:

- On feature merge, drain `verify_issues` of severity `nit` into a durable pool of task-candidates keyed by location/description.
- Planner (or a dedicated maintenance agent) periodically converts accepted candidates into real tasks on an appropriate feature or a dedicated "polish" feature.
- Operators can browse, accept, reject, or defer candidates.

This closes the loop so that non-blocking observations are captured for later rather than dropped on the floor.

## Open Questions

To resolve before designing the pool:

- **Verifier guidance for `nit` vs `concern`.** The prompt today lists severities without detailing when a finding should be a nit rather than a concern. Real verifier runs are needed to calibrate the boundary, and the prompt will likely need follow-up guidance (examples, heuristics) once drift shows up.
- **Nit lifecycle across the feature timeline.** `features.verify_issues` accumulates nits on an un-merged feature and clears when a replan is approved. The behavior on feature merge is not yet specified — today nothing consumes the nits at that point, and this pool is the natural home for draining them. A decision is also needed for nits that survive replan cycles: do they carry forward, or does the replanner get a chance to ack/clear them?

## Why Deferred

- Baseline verifier emits nits only as an observability side channel today; volume and quality are unknown until the verifier has run against real work.
- Introducing a maintenance/polish feature and pool-management UI expands surface area beyond the core DAG execution model.
- Scheduling policy for polish work (priority, when to dispatch, which feature owns it) needs design.

Until then, nits are surfaced in the verification summary and stored on `features.verify_issues`; consumers that want them can read them directly.
