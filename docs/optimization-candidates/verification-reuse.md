# Optimization Candidate: Verification Reuse

## Status

Future optimization candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline model is:
- task-level checks are fast and local
- `ci_check` runs the full configured heavy feature command list before agent-level spec review
- merge-train verification runs the full configured merge-train command list again after rebasing onto the latest `main`

This is intentionally conservative and simple.

## Possible Future Optimizations

### Reuse verified feature-CI results when merge-train input is unchanged
If a merge-train branch is effectively the same verified feature SHA and no meaningful code changes were introduced by rebase, the system could reuse prior `ci_check` results instead of rerunning the entire suite.

### Preflight before full merge-train suite
The merge train could run a fast preflight first (for example: typecheck + a narrow smoke set), then only run the expensive full suite if preflight passes.

### Skip unchanged verification commands
If a command's relevant inputs are unchanged between `ci_check` and merge-train verification, the system could skip or reuse that command's result.

### Material-change detection
Introduce a diff classifier that decides whether the rebase changed only metadata / ordering / generated output versus real source behavior, and gate verification reuse on that decision.

## Caveat

These optimizations are likely complex and should be tuned based on real repo behavior and user feedback. Start with the conservative baseline first.
