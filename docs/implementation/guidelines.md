# Implementation Phase Doc Guidelines

How to author phase docs under `docs/implementation/<track>/`. See `guidelines-example.md` for a worked example, `guidelines-rationale.md` for the design reasoning behind these rules. Tracks may retrofit existing phases when convenient; not required.

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

Title `<display-name>` is the human-readable form of the slug (e.g., slug `protocol-and-registry` → display `Worker protocol & registry`).

### Contract vs Plan

- **Contract** is frozen at phase start. Changes require an explicit revision note: edit in place and append a parenthetical with date and prior text. Do not delete prior text. For Scope.In/Out additions, prefix with `(added 2026-04-12) ...`.
  ```
  - Goal: workers can register, heartbeat, AND receive `dispatchRun` over the wire (revised 2026-04-12: prior Goal stopped at heartbeat; phase-2-remote-task-execution scope-collapsed back into this phase after spike showed wire format is shared).
  ```
- **Plan** is mutable. Revise as understanding deepens — no ceremony required.
- If work uncovers a Contract change (scope grew, exit criteria wrong), stop and surface it; do not silently reshape the Contract to match what was built.

### Header fields

- **Status** — `drafting` | `active` | `paused` | `shipped <SHA>` | `superseded`. If a phase is blocked mid-flight, set `paused` and add `## Blocker:` in Plan.
- **Verified state** — record the `main` SHA and date at phase-doc authoring time. Background reflects this anchor. Bump when implementation-relevant code on `main` invalidates Background; doc-only commits do not require a bump.
- **Depends on** — list of `phase-<N>-<slug>` ids with one-line reasons.
- **Default verify** — runs after every step unless the step overrides.
- **Phase exit** — one combined field: verify command + observable post-conditions + optional manual smoke, written as semicolon-separated clauses. Omit the smoke clause when not applicable.
- **Doc-sweep deferred** — explicit list of docs that will lag code during this phase. Reconcile in a single doc-only commit at phase exit. Omit the field when no drift is expected — an omitted field is itself an assertion of no drift, equivalent to listing `none`.

### Contract fields

- **Goal** — one sentence, observable outcome.
  - bad: `Add the workers table and heartbeat frame.` (names implementation)
  - good: `Workers can register, declare capacity, and heartbeat; the orchestrator persists them as a queryable seam.`
- **Scope.In** — what this phase delivers.
- **Scope.Out** — non-goals, even tempting nearby work. Items name an owner phase id when another phase picks them up: `worker takeover (phase-5-leases-and-recovery)`. `Out` is a *boundary*, not a task list — past ~6 items, ask whether the phase is too narrow or another phase is missing.
- **Exit criteria** — observable post-conditions orthogonal to per-step verifies: grep zero hits, byte-identical schema, no silent fallback, behavior X visible in TUI.
  - bad: `All tests pass. Build is green. No lint errors.` (already covered by Default / Phase exit verify)
  - good: `Grep for legacy 'HELP:' prefix returns zero hits. agent_events row exists after smoke. TUI renders without unknown-event fallback.`

### Plan fields

- **Background** — recon memo. Cite paths + line ranges + current behavior; deltas only. Skip facts already in track glossary or architecture docs.
  - bad: paragraphs explaining how the subsystem works, or restating architecture (`The runtime uses process-per-task with squash-merge feature branches...` — link to `docs/architecture/` instead).
  - good: `submitFeature() at src/orchestrator/planner-host.ts:142 sets status before validating input; tests at test/unit/planner-host.test.ts:88 only assert post-state, masking the order bug.`
- **Notes** — open questions and watch items the phase doc must carry but does not commit to resolving. Not deferred work (that lives in `Scope.Out` or `docs/concerns/`).
  - bad: `Open: should we also clean up zombie worktrees?` (TODO disguised as question; deferred work)
  - good: ``Open: should `urgency` be a free string or an enum? Draft uses enum; revisit if more levels surface.``

## Steps

Tier is implicit from `[risk: ..., size: ...]`. Authors include only tier-appropriate fields; reviewers enforce. Default to Light when the step fits its shape; round up only when risk is genuinely ambiguous.

### Sizing rubric

- **Size** — `S` single file, ≲50 LOC, mechanical | `M` 1-3 files, ≲300 LOC, narrow feature/refactor | `L` 3+ files OR cross-component OR new module surface.
- **Risk** — `low` additive, `git revert` clean, no side effects | `med` touches behavior on a hot path or shared in-process types/contracts | `high` schema/migration/protocol/irreversible/cross-process invariant.
- **Tier mapping** — `Light` = `low` + `S`; `Standard` = `low|med` + `S|M`; `Heavy` = `high` OR `L`.

### Step templates

**Light** — `risk: low, size: S`. Trivial: rename, doc tweak, single-line fix.
```
### X.Y name [risk: low, size: S]
What: ...
Commit: <conventional commit subject>
```
Default verify runs. No tests/review/rollback fields needed.

**Standard** — `risk: low|med, size: S|M`. Most steps. Additive code, small refactor, narrow feature.
```
### X.Y name [risk: med, size: M]
What: ...
Files: ...                 # omit if obvious from What
Tests: ...
Review goals: 1) ... 2) ...
Commit: ...
```

**Heavy** — `risk: high` OR `size: L`. Schema migration, protocol change, irreversible cutover, cross-component coordination.
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

**Rollback** — include only when `git revert` does NOT fully undo the step: schema migrations needing a down-step or snapshot, env-var renames or config flips operators must reverse, deploy artifacts already shipped, published packages, or other out-of-band side effects. Pure code edits omit the field; revert is implied.

**No `Behavior diff` field.** Phase Goal and step `What:` already carry before/after. If a step's effect is non-obvious, fix `What:`. Cutover ordering — when old and new paths must NOT coexist across commits — goes in `Migration ordering:`.

### Step rules

- **One step = one commit.** Verbatim conventional subject in `Commit:`. If a step needs two commits, it's two steps.
  - bad: `1.1 Add type. 1.2 Add export.` (cosmetic split — one logical change in two commits)
  - good: split only when each commit leaves a green tree AND ships a coherent slice.
- Green tree between commits (Default verify passes).
- Phase header states total commits: "Ships as N commits, in order." If `Doc-sweep deferred` is non-empty, the closing doc-only commit is included in the count.
- Step numbering is `X.Y`. Half-steps (`X.Y.a`, `X.Y.b`) are still **separate commits** — the shared `X.Y` prefix only signals "these substeps land together as one logical change." Prefer splitting into two `X.Y` entries when the substeps are independently reviewable.
- **Commit scope** — module-scoped: `feat(runtime/ipc): ...`, `fix(persistence): ...`, `docs(implementation): ...`. Subject ≤72 chars; details in the body.
  - bad: `feat: improvements`, `fix: misc cleanup`, `chore: updates`
  - good: `feat(runtime/ipc): add help_request frame and event-kind migration`
- **`Files:` format** — one path per item. Use `:line` for site-specific edits (`src/runtime/ipc/frames.ts:204`); omit it for whole-file rewrites or new files (`src/runtime/registry/transport.ts (new)`). Multi-line lists indent two spaces under the label. Omit the field when fully redundant with `What:` (single-file mechanical edit). **No descriptive parentheticals** — `What:` carries intent; `Files:` is location only. Only `(new)` is allowed.
  - bad: `src/x.ts (add zod schema and validate input)` — good: `src/x.ts:204`.
- **`Tests:` rubric** — Standard / Heavy: list test files OR `tests deferred to step X.Y (<reason>)`. Light: optional; pure-doc step omits. Refactor with no behavior change: name the existing test file (`covered by test/unit/foo.test.ts`). Silence is not allowed on Standard / Heavy.
- **`Review goals:`** is a numbered checklist for the reviewer. Word cap by tier: **Light 50**, **Standard 100**, **Heavy 250** — tiers already encode complexity, the cap follows. Override with explicit annotation (`Review goals: (cap 350 words) 1) ...`) only when the surface genuinely exceeds its tier.
- **Per-step `Smoke:`** is distinct from the smoke clause of `Phase exit`. Per-step smoke exercises just this step in isolation; phase-exit smoke exercises the phase end-to-end. Either may be present without the other.
- **Per-step fields appear only when overriding a header default.** Do not restate `Verification:`, `Approach:`, or any field whose value matches the header.
  - bad: `Verification: npm run check:fix && npm run check.` on every step | `Approach: TDD.` on every step in a TDD-by-convention track.

### Phase-level budget

Step tier governs per-step length; these caps govern the whole doc. They are soft targets unless the Plan justifies otherwise. Per-step and total budgets are independent — a phase can hit either ceiling first.

- **Total phase doc** — target ≤ 2000 words; hard cap ~3000.
- **Per-step word budgets** — Light ≤ 100 words; Standard 300–500 words; Heavy ≤ 800 words.
- **Background** — ≤ 300 words, ≤ 10 bullets. Beyond that, hoist context into `docs/architecture/` and cite.
- **Notes** — ≤ 5 items.
- **Heavy-tier density** — more than 5 Heavy-tier steps in one phase signals scope is too broad. Split before authoring.
- **Cross-phase pin-down** ("phase-X owns Y; phase-Z wires it") belongs in the track README's dependency table or in `Depends on:`. Cite the dep once.

## Anti-patterns checklist

Reviewer scan list. Each entry links to the rule that owns the full `bad:` / `good:` example.

- **Goal names implementation, not outcome** → Contract fields > Goal
- **Exit criteria duplicate per-step verifies** → Contract fields > Exit criteria
- **Background restates architecture, or runs as prose narrative** → Plan fields > Background
- **Notes are TODOs disguised as questions** → Plan fields > Notes
- **Unbounded scope creep into Out** (>~6 items) → Contract fields > Scope.Out
- **Cosmetic step splits** → Step rules > One step = one commit
- **Vague commit subjects** (`feat: improvements`) → Step rules > Commit scope
- **`Files:` descriptive parentheticals** or **`Files:` duplicates `What:`** → Step rules > `Files:` format
- **Per-step `Verification:` / `Approach:` restates header default** → Step rules > Per-step fields appear only when overriding a header default

## Optional patterns

Use only when they earn their keep.

- **RED→GREEN narrative** — when TDD step ordering is load-bearing, use `compile-RED` (new symbol referenced before it exists; fails typecheck), `assertion-RED` (test runs but fails on behavior), and `GREEN` (implementation lands; test passes). For a single-test-then-implement step, omit and let the test file name speak.
- **`assertNever` exhaustiveness** — when extending a discriminated union, `switch` over the discriminator with `assertNever(value satisfies never)` in the default arm. Cite in `What:`: `extend Foo union; assertNever guard at bar.ts:54 will compile-RED until step X.Y handles the new arm`.

## Style

- Concrete > abstract. Use exact paths, symbols, types, enum values, SQL, frame fields, env keys.
- Pseudocode only when sequencing is load-bearing.
- Imperative tone. Say what NOT to do and why.
- Warn about drift: re-read file at edit time.
- Bold step-field labels (`**What:**`) are optional; pick one style and stay consistent within a phase. Header-bullet field names (`- Status:`) and Contract/Plan field names (`- Goal:`) stay plain because bolding fights bullet structure.

## Glossary

Track-specific jargon (`submit invariants`, `frame fields`, `escalation prompt`) lives in `docs/implementation/<track>/glossary.md` once it recurs across 3+ phases. Phase docs link the term on first occurrence per phase. For one-off terms, gloss inline: `submit invariants (rules a planner submit must satisfy)`. Cross-track concepts (`worktree`, `merge train`, `feature branch`) live in `docs/architecture/` — link there, don't redefine.

**Bootstrap** — copy `docs/implementation/glossary-template.md` to `docs/implementation/<track>/glossary.md` and start populating from your phase docs.

## Cross-doc references

- Link architecture, specs, concerns, feature-candidates to justify invariants and route deferred work.
- Distinguish live source vs doc mirror, runtime vs architecture ownership.
- Open design edges resolved in-doc with explicit decision; unresolved moved to `docs/concerns/` or `docs/feature-candidates/`. No fuzzy in-doc TODOs.

## Closing a phase

1. Run the verify command and any smoke scenario from the `Phase exit` field.
2. Reconcile `Doc-sweep deferred` items in a single doc-only commit.
3. Update `Status:` to `shipped <SHA>`. Append `Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>` footer. Update the track README row.
4. If superseded later, set `Status: superseded` and link the replacement phase id.
