# Optimization Candidate: Testing Cost Reduction

## Status

Future optimization candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline testing/verification model intentionally duplicates confidence checks:
- light/local checks at task submit
- full checks at `ci_check`
- full checks again in the merge train after rebasing onto latest `main`

This prioritizes correctness and predictable semantics over speed.

## Possible Future Optimizations

### Command-level caching
Cache verification command results keyed by branch SHA, command, and relevant inputs.

### Layer-specific suites
Refine which commands run at task / feature / merge-train layers based on observed value and cost, while keeping each layer configurable as an editable command list.

### Hot-path smoke tests in merge train
Run a short smoke suite immediately after rebase, then run the full suite only if the smoke stage succeeds.

### Adaptive verification
Escalate verification depth based on conflict risk, rebase size, or affected subsystems rather than always paying the same cost.

## Caveat

These optimizations are likely complex and should be introduced only after the baseline system has produced real timing and failure data.
