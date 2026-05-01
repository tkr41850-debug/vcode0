# Implementation Phase Doc Guidelines

How to author phase docs under `docs/implementation/<track>/`. Distilled from patterns across the baseline, project-planner, and distributed tracks.

See `guidelines-example.md` for a worked example. Tracks may retrofit existing phases on a per-track basis when convenient; not required.

## Authority

- README of each track owns global phase ordering. Phase docs MUST NOT assert ordinal position. Banned phrasing: `Phase 5`, `the previous phase`, `next phase`, `earlier in this milestone`.
- Phase number is **stable identity**, not ordinal claim. Insertions take the next free number (no `4.5`). Canonical id `phase-<N>-<slug>` matches the filename. Cross-phase deps cite this id with a one-line reason: `Depends on: phase-1-protocol-and-registry (registry surface)`.
- Cumulative refs to the rest of the track are reorder-safe and allowed: `other phases in this track`, `the cumulative state shipped by this track`. Numbered ranges (`phases 0–6`) are not.
- Intra-phase step ordering is the phase's job and lives in the phase doc.

## File path and registration

- Path: `docs/implementation/<track>/phase-<N>-<slug>.md`. Slug is kebab-case, lowercase, ≤4 words.
- Register in the track README: add a row to the ordinal table with id, slug, one-line goal, and current `Status:`. README ordinal sequence is the source of truth.

## Doc spine

```
# Phase <N> — <slug-name>

Status: drafting | active | paused | shipped <SHA> | superseded
Verified state: main @ <SHA> on <YYYY-MM-DD>
Depends on: phase-<N>-<slug> (<reason>), ...
Default verify: npm run check:fix && npm run check
Phase exit verify: npm run verify
Phase exit smoke: <manual scenario, or "none">
Doc-sweep deferred: <docs that will lag this phase, or "none">

## Contract (frozen at phase start)

Goal: ...
Scope:
  In: ...
  Out: ...
Exit criteria: ...

## Plan (mutable)

Background: ...
Notes: ...

## Steps

### X.Y name [risk: ..., size: ...]
...

---
Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>
```

`Contract` is frozen at phase start; changes require an explicit revision note. `Plan` is mutable; revise as work progresses without ceremony.

## Header fields

- **Status** — `drafting` | `active` | `paused` | `shipped <SHA>` | `superseded`. If a phase is blocked mid-flight, set `paused` and add `## Blocker:` in Plan.
- **Verified state** — pin the `main` SHA at phase-doc authoring time, plus date. The Background reflects state at this anchor; re-verify if much time passes before work begins.
- **Depends on** — list of `phase-<N>-<slug>` ids with one-line reasons.
- **Default verify** — runs after every step unless the step overrides.
- **Phase exit verify** — stronger gate than per-step verify; runs once before closing the phase.
- **Phase exit smoke** — manual scenario that exercises the phase's user-visible outcome. Use `none` if not applicable.
- **Doc-sweep deferred** — explicit list of docs that will lag code during this phase. Reconcile in a single doc-only commit at phase exit. Use `none` to assert no drift expected.

## Contract block

- **Goal** — one sentence, observable outcome.
- **Scope.In** — what this phase delivers.
- **Scope.Out** — what this phase does NOT do, even tempting nearby work. Items name an owner phase id if another phase will pick them up: `worker takeover (phase-5-leases-and-recovery)`. `Out` is a *boundary*, not a task list.
- **Exit criteria** — observable outcomes orthogonal to per-step verifies. Things that prove the phase as a whole landed: grep zero hits, byte-identical schema, no silent fallback, behavior X visible in TUI.

## Plan block

- **Background** — recon memo, not rationale. Cite paths + line ranges + current behavior. Compare intended vs actual; name false assumptions. Skip facts already in track glossary or architecture docs; record deltas only.
  - Example: `submitFeature() at src/orchestrator/planner-host.ts:142 sets status before validating input; tests at test/unit/planner-host.test.ts:88 only assert post-state, masking the order bug.`
- **Notes** — open questions and watch items the phase doc must carry, but does not commit to resolving here. Not deferred work (that lives in `Scope.Out` or external concern/candidate docs).
  - Example: `Open: idempotency key derived from feature-id or commit SHA? Draft uses feature-id; revisit if cross-feature collisions surface.`

## Step template (tiered)

Tier is implicit from the `[risk: ..., size: ...]` label. Author includes only fields appropriate to tier; reviewer enforces.

### Sizing rubric

- **Size**
  - `S` — single file, ≲50 LOC, mechanical.
  - `M` — 1-3 files, ≲300 LOC, narrow feature or refactor.
  - `L` — 3+ files OR cross-component OR new module surface.
- **Risk**
  - `low` — additive, reversible by `git revert` with no side effects.
  - `med` — touches behavior on a hot path, or shared types/contracts in-process.
  - `high` — schema/migration/protocol/irreversible/cross-process invariant.

When in doubt, round up. A bigger label costs a few extra fields; a smaller label hides risk.

### Light — `risk: low, size: S`

Trivial: rename, doc tweak, single-line fix.

```
### X.Y name [risk: low, size: S]
What: ...
Commit: <conventional commit subject>
```

Default verify runs. No tests/review/rollback fields needed.

### Standard — `risk: low|med, size: S|M`

Most steps. Additive code, small refactor, narrow feature.

```
### X.Y name [risk: med, size: M]
What: ...
Files: ...                 # omit if obvious from What
Tests: ...
Review goals: 1) ... 2) ...
Commit: ...
Rollback: revert
```

### Heavy — `risk: high` OR `size: L`

Schema migration, protocol change, irreversible cutover, cross-component coordination.

```
### X.Y name [risk: high, size: L]
What: ...
Files: ...
Tests: ...
Review goals: 1) ... 2) ...
Commit: ...
Rollback: <explicit recipe, tested if possible>
Behavior diff: before → after
Smoke: <manual scenario>
Migration ordering: <multi-commit dance, if any>
Crash matrix: <if recovery-relevant>
```

### Step rules

- One logical change per commit. Green tree between commits.
- Phase header states total commits: "Ships as N commits, in order."
- Step numbering is `X.Y`. Half-steps (`X.Y.a`, `X.Y.b`) are allowed when a single logical step splits cleanly into ordered substeps; prefer splitting into two `X.Y` entries when feasible.
- `Commit:` field carries the verbatim conventional commit subject.
- `Review goals:` is a numbered list of what the reviewer must check. Default word cap **250 words** unless the phase header sets another. Tool-agnostic; the subagent prompt is assembled from these goals at review time.

## Style

- Concrete > abstract. Use exact paths, symbols, types, enum values, SQL, frame fields, env keys.
- Pseudocode only when sequencing is load-bearing.
- Imperative tone. Say what NOT to do and why.
- Warn about drift: re-read file at edit time.
- Bold labels (`**What:**` vs `What:`) are author choice. Pick one and stay consistent within a phase.
- Hoist defaults to the phase header; per-step only when deviating.

## Glossary

Track-specific jargon (`submit invariants`, `frame fields`, `escalation prompt`) lives in `docs/implementation/<track>/glossary.md` once a term recurs across 3+ phases. Phase docs link the term on first occurrence per phase.

For one-off terms, gloss inline on first use: `submit invariants (rules a planner submit must satisfy)`.

Cross-track concepts (`worktree`, `merge train`, `feature branch`) live in `docs/architecture/` — link there, don't redefine.

## Cross-doc references

- Link architecture, specs, concerns, feature-candidates to justify invariants and route deferred work.
- Distinguish live source vs doc mirror, runtime vs architecture ownership.
- Open design edges resolved in-doc with explicit decision; unresolved moved to `docs/concerns/` or `docs/feature-candidates/`. No fuzzy in-doc TODOs.

## Closing a phase

1. Run the `Phase exit verify` command and the `Phase exit smoke` scenario from the header.
2. Reconcile `Doc-sweep deferred` items in a single doc-only commit.
3. Update `Status:` to `shipped <SHA>`.
4. Append `Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>` footer.
5. Update the track README row for this phase.
6. If the phase is superseded later, set `Status: superseded` and link the replacement phase id.
