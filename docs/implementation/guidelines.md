# Implementation Phase Doc Guidelines

How to author phase docs under `docs/implementation/<track>/`. Derived from patterns across the baseline, project-planner, and distributed tracks.

## Authority

- README of each track owns global phase ordering. Phase docs MUST NOT state their own ordinal position relative to other phases.
- Phase number is a **stable identity**, not an ordinal claim. Numeric order may diverge from ship order over time; insertions take the next free number, not a fractional one (no `4.5`). Canonical phase id is `phase-<N>-<slug>`, matching the filename.
- Cross-phase dependencies cite the canonical id with a one-line reason: `Depends on: phase-1-protocol-and-registry (registry surface)`. The number is part of the id; what's forbidden is language that asserts position (`Depends on Phase 5`, `the previous phase`, `next phase`).
- Intra-phase step ordering is the phase's job and is stated in the phase doc.

## Doc spine

```
# Phase: <slug-name>

Status: drafting | active | shipped <SHA> | superseded
Verified state: as of <SHA> / <YYYY-MM-DD>
Depends on: phase-<N>-<slug> (<reason>), ...
Default verify: npm run check:fix && npm run check
Phase exit: npm run verify + <smoke>
Doc-sweep deferred: <docs that will lag this phase>

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

- **Status** — one of `drafting`, `active`, `shipped <SHA>`, `superseded`. Update as phase progresses. Append `Shipped in <SHA1>..<SHA2> on <date>` footer at completion.
- **Verified state** — pin commit SHA. `as of today's main` rots fast.
- **Depends on** — slug + one-line reason. No phase numbers.
- **Default verify** — hoisted command run after every step unless the step overrides.
- **Phase exit** — stronger bar than per-step verify, plus smoke / manual scenario if any.
- **Doc-sweep deferred** — explicit list of docs that will lag code during this phase. Reconcile in a sweep commit at phase exit. Replaces the implicit drift convention.

## Contract block

- **Goal** — one sentence, observable outcome.
- **Scope.In** — what this phase delivers.
- **Scope.Out** — what this phase does NOT do, even tempting nearby work. Each item names an owner phase id if another phase will pick it up: `worker takeover (phase-5-leases-and-recovery)`. `Out` is a *boundary*, not a task list.
- **Exit criteria** — observable outcomes orthogonal to per-step verifies. Things that prove the phase as a whole landed: grep zero hits, byte-identical schema, no silent fallback, behavior X visible to user.

## Plan block

- **Background** — recon memo, not rationale. Cite paths + line ranges + current behavior. Compare intended vs actual; name false assumptions. Skip facts already in track glossary or architecture docs; record deltas.
- **Notes** — open questions and risks. *Not* deferred work (that lives in `Scope.Out` or external candidate/concern docs). `Out` = won't do this phase. `Notes` = unresolved or watching.

## Step template (tiered)

Tier is implicit from the `[risk: ..., size: ...]` label. Author includes only fields appropriate to tier; reviewer enforces.

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
- Numbering is `X.Y` only. No half-steps (`2.3.5`, `4.6.a`). If you feel the urge, the step is too big — split into two.
- `Commit:` field carries the verbatim conventional commit subject.
- `Review goals:` is a numbered list of what the reviewer must check, with a word-cap suggestion. Tool-agnostic; subagent prompt is assembled from goals at review time.

## Style

- Concrete > abstract. Use exact paths, symbols, types, enum values, SQL, frame fields, env keys.
- Pseudocode only when sequencing is load-bearing.
- Imperative tone. Say what NOT to do and why.
- Warn about drift: re-read file at edit time.
- Avoid heavy bold on labels (`What:` not `**What:**`) — saves tokens at scale.
- Hoist defaults to phase header; per-step only when deviating.

## Glossary

Track-specific jargon (`submit invariants`, `frame fields`, `escalation prompt`) lives in `docs/implementation/<track>/glossary.md` once a term recurs across 3+ phases. Phase docs link the term on first occurrence per phase.

For one-off terms, gloss inline on first use: `submit invariants (rules a planner submit must satisfy)`.

Cross-track concepts (`worktree`, `merge train`, `feature branch`) live in `docs/architecture/` — link there, don't redefine.

## Cross-doc references

- Link architecture, specs, concerns, feature-candidates to justify invariants and route deferred work.
- Distinguish live source vs doc mirror, runtime vs architecture ownership.
- Open design edges resolved in-doc with explicit decision; unresolved moved to `docs/concerns/` or `docs/feature-candidates/`. No fuzzy in-doc TODOs.

## Closing a phase

1. Run `npm run verify` and any smoke from phase exit.
2. Reconcile `Doc-sweep deferred` items in a single doc-only commit.
3. Update `Status:` to `shipped <SHA>`.
4. Append `Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>` footer.
5. If phase superseded later, update header to `Status: superseded` and link the replacement.
