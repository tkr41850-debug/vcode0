# Feature Candidate: Merge-Step File-Filtering Audit

## Status

Audit candidate (not an implementation candidate). Surfaced from the [2026-04-29 deep-dive synthesis](../../compare/landscape/2026-04-29-deep-dive-synthesis.md).

This entry tracks a one-time investigation. The output is a documented finding (vulnerability confirmed and patched, or vulnerability does not apply with reasoning), not an ongoing feature.

## Baseline

gvc0's merge train integrates feature branches into `main` through:

1. Rebase the feature branch onto `main`.
2. Run post-rebase CI on the rebased tip.
3. Validate `main`'s SHA hasn't moved between rebase and merge.
4. `git merge --no-ff` into `main`.

The merge step processes the full feature-branch contents — there is no file-filtering layer between the rebased tip and the merge commit.

## Candidate Audit

[Overstory issue #103](https://github.com/jayminwest/overstory/issues/103) describes a bug class where the merge step's file-filtering logic could allow a file to be excluded from a merge while CI ran on the unfiltered contents. The result: CI green, but `main` ends up with an inconsistent state.

The audit question for gvc0:

1. **Does gvc0 have an analogous file-filtering layer?** The current implementation does not, but the question is whether any code path effectively filters files (e.g., a `.gitattributes` `merge=ours` rule, a custom merge driver, a hook that mutates the index between CI and merge).
2. **If no analogous layer exists, document why the bug class does not apply.** This is the likely finding, but it should be written down with citations to the relevant files so future contributors don't reintroduce the pattern.
3. **If an analogous surface exists or could be added (e.g., via a future feature like selective-file-merge), document the invariant that prevents the bug class.** The invariant is roughly "CI runs on the same tree that gets merged into `main`."

## Why It Matters

gvc0's merge-train invariant chain (rebase → post-rebase CI → main-SHA validation → `merge --no-ff`) is one of three remaining moats. Confirming it does not share a known competitor bug class strengthens the moat; finding it does share the bug would be a high-severity surprise.

This is a small, finite audit. The downside of skipping it is a slow discovery later, possibly under unfortunate circumstances (a user reports a near-miss, or a competitor publishes a comparison highlighting the gap).

## How the Audit Would Run

1. **Read Overstory issue #103 carefully.** Establish exactly which step in their merge pipeline filters files, and exactly which CI step runs on which tree state.
2. **Map to gvc0's merge train.** Walk `src/orchestrator/merge-train/*` and identify every place where the tree the worker submitted differs from the tree CI runs on or the tree merged into `main`. Expected output: a sequence diagram with three tree-state nodes (worker submit, CI input, merge input) and zero edges that mutate without re-running CI.
3. **Confirm with code citations.** For each tree-state node, cite the function and line in gvc0 source.
4. **Write the finding.** A new section in `docs/operations/merge-train.md` (or wherever the merge-train invariants are documented) titled "Audit: Overstory issue #103 file-filtering bug class," with:
   - One-paragraph summary of the Overstory bug class.
   - Mapping to gvc0's merge train.
   - Citation-backed conclusion (does not apply / applies-but-mitigated / applies-and-needs-fix).
5. **If a fix is required** (low probability, but plan for it): convert this candidate into a regular feature candidate with a concrete plan.

## Why Deferred

This is not a "deferred feature." It's a one-time audit with a finite scope. It's listed in feature-candidates/ because the directory is the natural home for "investigation surfaced by a comparison page that hasn't been actioned yet." When the audit completes, this entry should be deleted (replaced by the documented finding in `docs/operations/merge-train.md`).

## When to Run

Whenever there is bandwidth for a focused 1–2 hour read of Overstory issue #103 + gvc0's merge train. Not blocking on anything else.

## Public references

- Overstory issue #103: <https://github.com/jayminwest/overstory/issues/103>
- Topic pages: [overstory.md](../../compare/competitors/overstory.md), [2026-04-29 deep-dive](../../compare/landscape/2026-04-29-deep-dive-synthesis.md).

## Notes Carried Forward From Design Discussion

- Considered making this a generalized "audit known competitor bugs" feature. Rejected: each audit has its own context and is best handled as a one-off. A standing audit framework is overhead-heavy for low expected ROI.
- Considered skipping the audit entirely. Rejected: the moat strength claim is asserted in [overstory.md](../../compare/competitors/overstory.md), and the assertion is cheap to verify.
