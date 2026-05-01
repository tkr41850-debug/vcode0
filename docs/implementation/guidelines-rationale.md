# Implementation Phase Doc Guidelines — Rationale

The "why" behind the rules in `guidelines.md`. Read this when designing meta-changes to the phase-doc system or wondering whether a rule still applies. Authors and reviewers do not need this file day-to-day; the rules in `guidelines.md` are self-contained.

## Origin

These guidelines were distilled from patterns across the `01-baseline`, `02-project-planner`, and `03-distributed` tracks. Each rule earned its place by failing in practice first.

## Authority — banned ordinal phrasing

Phase numbers are stable identity, not ordinal claims. Phase docs that say "the previous phase" or "Phase 5" lock the track into a specific numeric sequence. Insertions then either renumber (breaking every cite) or get suffixed (`4.5`) and read poorly. The ban + the cumulative-refs allowance together let track READMEs reorder without phase-doc churn.

## Contract vs Plan distinction

Why two top-level sections with different mutability rules:

- The Contract is the phase's commitment. Reviewers and the README track what the phase committed to. Silently rewriting Goal or Scope to match what was actually built defeats the audit trail and lets scope creep land unobserved.
- The Plan is working memory: recon notes, draft step lists, open questions. Forcing a revision recipe on Plan changes would discourage updating it as understanding deepens, leading to stale Background sections that mislead reviewers.

The revision recipe (in-place edit + parenthetical note) is the lightest possible audit trail. Heavier alternatives (separate revision log, git-history mining) added friction without preventing scope drift any better.

## No `Behavior diff` field

`Behavior diff:` was a candidate field for "what changes for the user/system after this step." Rejected because:

- The phase `Goal` already carries phase-level before/after.
- The step's `What:` carries step-level before/after.
- Adding a third place to encode the same information meant either redundancy or contradictory drift.

If a step's effect is non-obvious from `Goal` + `What:`, the fix is to sharpen `What:`, not add a parallel field.

## Rollback is conditional

Rollback was originally required on every Heavy step. In practice, most Heavy steps were pure code edits where `git revert` undoes everything cleanly. Authors copy-pasted `Rollback: git revert this commit.` 80% of the time, which trained reviewers to skip the field. Making Rollback conditional (only when revert is insufficient) restored its signal.

## Review goals are tool-agnostic

Original framing tied Review goals to a specific subagent invocation pattern. When the subagent harness changed, every phase doc went stale. Tool-agnostic phrasing — "what the reviewer must check" — survives harness churn. The subagent prompt is assembled from these goals at review time.

The 100-word default cap exists because authors filled to whatever cap was set; the previous 250-word default produced bullets that reviewers skimmed.

## Default to Light

Original rule was "round up when in doubt" — favored over-disclosure. In practice this meant a 1-line typo fix shipped with a Standard template (Files + Tests + Review goals + Commit), all of which were either trivially obvious or `n/a`. The wrong-fit template wastes review surface and crowds genuinely heavy steps that need the same fields filled out. Defaulting to Light + reviewer enforcement keeps the heavy templates rare and meaningful.

## Phase-level budget

Phase 4 of the 03-distributed track ran 3221 words across 11 steps with no guideline pushback. The doc was structurally correct but past the human glaze threshold (~30 min careful read before approval). The budgets are calibrated against measured phase docs:

- Heavy ≤ 800 words holds for nearly all genuinely heavy steps observed.
- Standard 300–500 words holds for the 02-project-planner phases after their normalization sweep.
- Background ≤ 300 words eliminates the prose-block pattern seen in early 03-distributed drafts.
- The ">5 Heavy steps signals phase too broad" rule comes from observing that phase 4 (7 Heavy) and phase 5 (6 Heavy) felt like two phases stitched together.

## Per-step header-default restatement

Authors copy-pasted `Verification: npm run check:fix && npm run check.` and `Approach: TDD.` onto every step in the 02-project-planner phases. 22 literal restatements of the Default verify across one track. The ban has two effects:

- Cuts ~50 words per phase.
- Forces the override case to stand out: when a step actually overrides the default, it is now visible.

## Cross-phase pin-down hoisted

Phrases like "phase-X owns Y; phase-Z wires it" appeared 3–5× per phase doc in 03-distributed. Each restatement was a maintenance hazard: when ownership moved between phases, every restatement had to be updated. Hoisting to the track README's dependency table + the `Depends on:` header gives a single source of truth.

## Optional patterns stay optional

RED→GREEN narrative and `assertNever` exhaustiveness are documented because authors kept reaching for them and reinventing the wording each time. They stay optional because:

- For a single-test-then-implement step, the test file name and `What:` already convey the ordering.
- For mechanical union extensions in a single commit, the `assertNever` guard is overkill.

Mandatory use would push these patterns into Light steps where they drown the actual change.

## Glossary template

The original guideline recommended a per-track glossary "once a term recurs across 3+ phases." No track ever bootstrapped one. Without a seed file, authors were not sure what a glossary entry should look like, so they kept glossing inline. The template gives the canonical shape so the first entry is cheap to write.
