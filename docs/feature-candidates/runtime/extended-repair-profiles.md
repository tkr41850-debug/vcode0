# Feature Candidate: Extended Repair Profiles

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline repair policy allows a fixed number of repair attempts (currently 1, defined as a const) before escalating to replan. This applies uniformly regardless of the configured token profile.

## Candidate

Tie the maximum repair attempts to the `TokenProfile` setting (`budget`, `balanced`, `quality`), allowing higher-investment profiles to attempt more repairs before escalating to the more expensive replan path.

For example:
- `budget`: 0 repair attempts (escalate to replan immediately, or skip replan and surface for user intervention)
- `balanced`: 1 repair attempt (baseline behavior)
- `quality`: 2-3 repair attempts (invest more in targeted fixes before replanning)

This could also extend to replan attempts and verification retry limits.

## Why Deferred

The baseline fixed-count policy is sufficient to validate the repair→replan escalation path. Profile-aware tuning is a refinement that depends on observing real failure patterns across different project types and sizes.
