# Implementation Phase Doc Guidelines

How to author phase docs under `docs/implementation/<track>/`. Distilled from patterns across the baseline, project-planner, and distributed tracks.

See `guidelines-example.md` for a worked example, `guidelines-rationale.md` for the design reasoning behind these rules. Tracks may retrofit existing phases on a per-track basis when convenient; not required.

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
# Phase <N> — <display-name>

- Status: drafting | active | paused | shipped <SHA> | superseded
- Verified state: main @ <SHA> on <YYYY-MM-DD>
- Depends on: phase-<N>-<slug> (<reason>), ...
- Default verify: npm run check:fix && npm run check
- Phase exit: <verify command + observable post-conditions; manual smoke scenario if applicable, else omit>
- Doc-sweep deferred: <docs that will lag this phase>   # omit field when none

Ships as N commits, in order.

## Contract

- Goal: <one sentence, observable outcome>
- Scope:
  - In: <bullet list of deliverables>
  - Out: <bullet list of explicit non-goals; cite owner phase id when another phase picks them up>
- Exit criteria: <bullet list of observable post-conditions, orthogonal to per-step verifies>

## Plan

- Background: <recon memo, paths + line ranges + current behavior; deltas only — ≤10 bullets, ≤300 words>
- Notes: <open questions and watch items, or "none" — ≤5 items>

## Steps

### X.Y name [risk: ..., size: ...]
What: <imperative summary of the change>
Files: <path:line, one per item; new files: path (new)>
Tests: <test files OR "tests deferred to step X.Y (<reason>)">
Review goals: 1) ... 2) ... 3) ...
Commit: <conventional commit subject, ≤72 chars>

---
Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>
```

Title `<display-name>` is the human-readable form of the slug (e.g., slug `protocol-and-registry` → display `Worker protocol & registry`). The canonical id stays `phase-<N>-<slug>` and matches the filename; the title is for readers.

The two top-level sections have distinct roles:

- **Contract** — the phase's commitment. Frozen at phase start. What this phase will deliver, what it will not, and what proves it landed. Changes require an explicit revision note (timestamped, in-place, do not silently rewrite). Steps and reviewers hold the phase to this.
- **Plan** — how the work will get done. Mutable. Revise as understanding deepens — recon notes shift, open questions resolve, step substance moves around. No ceremony required for changes here.

If a discovery during work would change the Contract (scope grew, exit criteria wrong), stop and surface it; do not silently re-shape the Contract to match what was actually built.

**Contract revision recipe** — edit the field in place; append a parenthetical note with date and prior text. Don't delete the prior text — reviewers and the README track what the phase committed to.

```
- Goal: workers can register, heartbeat, AND receive `dispatchRun` over the wire (revised 2026-04-12: prior Goal stopped at heartbeat; phase-2-remote-task-execution scope-collapsed back into this phase after spike showed wire format is shared).
```

For Scope.In/Out additions, prefix the new item with `(added 2026-04-12) ...`. For Exit criteria changes, same pattern.

## Header fields

- **Status** — `drafting` | `active` | `paused` | `shipped <SHA>` | `superseded`. If a phase is blocked mid-flight, set `paused` and add `## Blocker:` in Plan.
- **Verified state** — pin the `main` SHA at phase-doc authoring time, plus date. The Background reflects state at this anchor; re-verify if much time passes before work begins. Bump the SHA when implementation-relevant code changes since the pin invalidate the Background; doc-only commits to `main` do not require a bump.
- **Depends on** — list of `phase-<N>-<slug>` ids with one-line reasons.
- **Default verify** — runs after every step unless the step overrides.
- **Phase exit** — single combined field carrying the verify command (stronger gate than per-step verify; runs once before closing the phase) plus the observable post-conditions and any manual smoke scenario that exercises the phase's user-visible outcome end-to-end. Multi-clause; semicolon-separated. Omit the smoke clause when not applicable.
- **Doc-sweep deferred** — explicit list of docs that will lag code during this phase. Reconcile in a single doc-only commit at phase exit. Omit the field entirely when no drift is expected.

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
  - `S` — single file, ≲50 LOC, mechanical. Examples: rename, doc tweak, additive log line, new test fixture.
  - `M` — 1-3 files, ≲300 LOC, narrow feature or refactor. Examples: new method on existing class, narrow refactor with same external surface, single-table migration.
  - `L` — 3+ files OR cross-component OR new module surface. Examples: new IPC frame end-to-end, new module + tests + integration wiring, cutover replacing old path with new.
- **Risk**
  - `low` — additive, reversible by `git revert` with no side effects. Examples: new file, additive log, doc edit, new test, new optional config field.
  - `med` — touches behavior on a hot path, or shared types/contracts in-process. Examples: branch on hot path, refactor with same external surface, new method on widely-used class.
  - `high` — schema/migration/protocol/irreversible/cross-process invariant. Examples: schema migration, IPC frame change, env-var rename, signal handler, security-posture change, deploy artifact.

Default to Light when the step fits its shape; reviewer enforces. Round up only when risk is genuinely ambiguous — Standard or Heavy template applied to a one-line fix is its own bloat. A bigger label costs a few extra fields; a smaller label hides risk; the wrong-fit template wastes review surface.

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
Rollback: <recipe, only if undo ≠ git revert>
Smoke: <manual scenario>
Migration ordering: <multi-commit dance, if any>
Crash matrix: <if recovery-relevant>
```

**Rollback** — include only when `git revert` does NOT fully undo the step: schema migrations needing a down-step or snapshot, env-var renames or config flips operators must reverse, deploy artifacts already shipped (systemd units, install scripts), published packages, or other out-of-band side effects. Pure code edits — additive frames, new modules, refactors — omit the field; revert is implied.

**Behavior diff** is intentionally NOT a field. The phase Goal and the step's `What:` already carry before/after. If a step's effect is non-obvious from those, fix the `What:` rather than add a parallel field. Cutover ordering — when old and new paths must NOT coexist across commits — goes in `Migration ordering:`.

### Step rules

- **One step = one commit.** Verbatim conventional subject in `Commit:`. If a step needs two commits, it's two steps.
- Green tree between commits (Default verify passes).
- Phase header states total commits: "Ships as N commits, in order." If `Doc-sweep deferred` is non-empty, the closing doc-only commit is included in the count.
- Step numbering is `X.Y`. Half-steps (`X.Y.a`, `X.Y.b`) are still **separate steps with separate commits** — the shared `X.Y` prefix only signals "these substeps land together as one logical change" for review. They do not violate one-step = one-commit. Prefer splitting into two `X.Y` entries when the substeps are independently reviewable.
- **Commit scope** — module-scoped: `feat(runtime/ipc): ...`, `fix(persistence): ...`, `docs(implementation): ...`. Bare `feat: improvements` is banned. Subject ≤72 chars; details in the body.
- **`Files:` format** — one path per item. Anchor with `:line` when the edit lands at a specific site (`src/runtime/ipc/frames.ts:204`); omit `:line` for whole-file rewrites or new files. New files: `src/runtime/registry/transport.ts (new)`. Multi-line lists indent under the `Files:` label, two-space indent per continuation line. Omit the field entirely when fully redundant with `What:`. **No descriptive parentheticals** — `What:` carries intent; `Files:` is location only. The only allowed parenthetical is `(new)` to mark a new file.
- **`Tests:` rubric** —
  - Standard / Heavy: list test files OR `tests deferred to step X.Y (<reason>)`. Silence is not allowed.
  - Light: optional. Pure-doc step: omit.
  - Refactor with no behavior change: name the existing test file that already covers the surface (`covered by test/unit/foo.test.ts`).
- **`Review goals:`** is a numbered list of what the reviewer must check. Default word cap **100 words**; override up to **250 words** with explicit annotation (`Review goals: (cap 250 words) 1) ...`) when the surface genuinely demands it. Tool-agnostic; the subagent prompt is assembled from these goals at review time.
- **`Smoke:` (per-step)** is distinct from the smoke clause of the **`Phase exit`** header field. Per-step smoke is a manual scenario that exercises just this step's behavior in isolation; phase-exit smoke exercises the phase's user-visible outcome end-to-end. A step may carry its own `Smoke:` even when the phase-exit smoke clause is omitted, and vice versa.

## Phase-level budget

Step tier governs per-step length; this section governs the doc as a whole. Soft targets unless the phase rationale (in Plan) justifies otherwise.

- **Total phase doc** — target ≤ 2000 words; hard cap ~3000.
- **Per-step word budgets** — Light ≤ 100 words; Standard 300–500 words; Heavy ≤ 800 words.
- **Background** — ≤ 300 words, ≤ 10 bullets. Beyond that, hoist context into `docs/architecture/` and cite.
- **Notes** — ≤ 5 items. Items that grow past one open question + a default belong in `docs/concerns/` or `Scope.Out`.
- **Heavy-tier density** — more than 5 Heavy-tier steps in one phase signals the phase scope is too broad. Split before authoring; do not let scope inflate doc length.
- **Cross-phase pin-down** ("phase-X owns Y; phase-Z wires it") belongs in the track README's dependency table or in the `Depends on:` header line. Phase docs cite the dep once and do not restate ownership prose per step.
- **Per-step fields appear only when overriding a header default.** Do not restate `Verification:`, `Approach:`, or any field whose value matches the header.

## Anti-patterns

Concrete shapes to reject in review.

- **Goal names implementation, not outcome**
  - bad: `Add the workers table and heartbeat frame.`
  - good: `Workers can register, declare capacity, and heartbeat; the orchestrator persists them as a queryable seam.`
- **Exit criteria duplicate per-step verifies**
  - bad: `All tests pass. Build is green. No lint errors.` (already covered by Default / Phase exit verify)
  - good: `Grep for legacy 'HELP:' prefix returns zero hits. agent_events row exists after smoke. TUI renders without unknown-event fallback.`
- **Background restates architecture**
  - bad: `The runtime uses a process-per-task model with squash-merge feature branches...` (in `docs/architecture/`; link there)
  - good: `submitFeature() at src/orchestrator/planner-host.ts:142 sets status before validating input; tests at test/unit/planner-host.test.ts:88 only assert post-state, masking the order bug.`
- **Notes are TODOs disguised as questions**
  - bad: `Open: should we also clean up zombie worktrees?` (this is deferred work; move to `Scope.Out` with owner phase or to `docs/concerns/`)
  - good: ``Open: should `urgency` be a free string or an enum? Draft uses enum; revisit if more levels surface.`` (a real open design question with a default)
- **Cosmetic step splits**
  - bad: `1.1 Add type. 1.2 Add export.` (one logical change in two commits)
  - good: split only when each commit leaves a green tree AND ships a coherent slice.
- **Vague commit subjects**
  - bad: `feat: improvements`, `fix: misc cleanup`, `chore: updates`
  - good: `feat(runtime/ipc): add help_request frame and event-kind migration`
- **Unbounded scope creep into Out**
  - `Out:` is a boundary against tempting nearby work; if it grows past ~6 items, ask whether the phase is too narrow or another phase is missing.
- **Per-step `Verification:` restates Default verify**
  - bad: `Verification: npm run check:fix && npm run check.` on every step (already in header `Default verify:`)
  - good: omit the field. Include only when this step overrides the header default.
- **Per-step `Approach:` restates track convention**
  - bad: `Approach: TDD.` on every step in a track that's TDD by convention.
  - good: state the convention once in the track README; omit per-step.
- **Background as prose narrative**
  - bad: paragraphs explaining how the subsystem works.
  - good: cited deltas — `frame.ts:204 currently does X; tests at foo.test.ts:88 only assert Y`.
- **`Files:` descriptive parentheticals**
  - bad: `src/x.ts (add zod schema and validate input)`
  - good: `src/x.ts:204` — `What:` carries intent; `Files:` is location only. Only `(new)` is allowed.
- **`Files:` duplicates `What:`**
  - bad: a `Files:` block whose intent is fully recoverable from `What:` (single-file mechanical edit).
  - good: omit the field — guidelines explicitly permit dropping it when redundant.

## Style

- Concrete > abstract. Use exact paths, symbols, types, enum values, SQL, frame fields, env keys.
- Pseudocode only when sequencing is load-bearing.
- Imperative tone. Say what NOT to do and why.
- Warn about drift: re-read file at edit time.
- Bold labels — applies to step-field labels (`**What:**` vs `What:`, `**Files:**` vs `Files:`, etc.). Author choice; pick one and stay consistent within a phase. Header-bullet field names (`- Status:`, `- Verified state:`) and Contract/Plan field names (`- Goal:`, `- Background:`) are always plain (no bolding) because they sit inside bullet lists where bolding fights the bullet structure.
- Hoist defaults to the phase header; per-step only when deviating.

## Optional patterns

These shapes recur enough to canonize but stay optional — use only when they earn their keep.

- **RED→GREEN narrative** — when TDD step-ordering is load-bearing (a test must compile and fail at one point, then pass at another), distinguish in the step body: `compile-RED` (new symbol referenced before it exists, fails at typecheck), `assertion-RED` (test runs but fails on behavior), `GREEN` (implementation lands, test passes). Use only when ordering ambiguity would mislead the reviewer or the implementing session; for a single-test-then-implement step, omit and let the test file name speak.
- **`assertNever` exhaustiveness** — when extending a discriminated union, the canonical compile-RED move is to `switch` over the discriminator and call `assertNever(value satisfies never)` in the default arm. The compiler then flags any unhandled new variant in a downstream commit as a build failure. Cite this in the step's `What:` when adding a variant: `extend Foo union; assertNever guard at bar.ts:54 will compile-RED until step X.Y handles the new arm`.

## Glossary

Track-specific jargon (`submit invariants`, `frame fields`, `escalation prompt`) lives in `docs/implementation/<track>/glossary.md` once a term recurs across 3+ phases. Phase docs link the term on first occurrence per phase.

For one-off terms, gloss inline on first use: `submit invariants (rules a planner submit must satisfy)`.

Cross-track concepts (`worktree`, `merge train`, `feature branch`) live in `docs/architecture/` — link there, don't redefine.

**Bootstrap** — copy `docs/implementation/glossary-template.md` to `docs/implementation/<track>/glossary.md` and start populating from your phase docs. The template carries the canonical header bullets, term-definition format, and link-back convention so every track's glossary has the same shape.

## Cross-doc references

- Link architecture, specs, concerns, feature-candidates to justify invariants and route deferred work.
- Distinguish live source vs doc mirror, runtime vs architecture ownership.
- Open design edges resolved in-doc with explicit decision; unresolved moved to `docs/concerns/` or `docs/feature-candidates/`. No fuzzy in-doc TODOs.

## Closing a phase

1. Run the verify command and any smoke scenario from the `Phase exit` header field.
2. Reconcile `Doc-sweep deferred` items in a single doc-only commit.
3. Update `Status:` to `shipped <SHA>`.
4. Append `Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>` footer.
5. Update the track README row for this phase.
6. If the phase is superseded later, set `Status: superseded` and link the replacement phase id.
