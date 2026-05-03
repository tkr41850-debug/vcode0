# Phase 1: Foundations & Clarity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** 01-foundations-clarity
**Mode:** `--auto` — all gray areas auto-selected with recommended option; no interactive user prompts.
**Areas discussed:** State diagram format, FSM test strategy, Boundary enforcement, Docs consolidation approach, Core contracts consolidation tactic, Decision-table format, State diagram scope, Newcomer narrative scope, Typed-ID namespace helpers, Warning rule shape.

---

## State diagram format

| Option | Description | Selected |
|--------|-------------|----------|
| Mermaid in markdown | Renders in GitHub + docs preview; editable as plain text; diff-friendly; single source of truth | ✓ |
| ASCII art | Current convention in ARCHITECTURE.md; fine for small overviews but illegible for the composite three-axis diagram | |
| External tool (PlantUML / draw.io) | Authoring lives outside the repo; exported images age poorly and require a toolchain | |

**User's choice:** Mermaid in markdown (auto-selected recommended).
**Notes:** Aligned with in-repo source-of-truth philosophy; composite three-axis diagram is illegible in ASCII.

---

## FSM test strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Exhaustive state-matrix enumeration + invariant tests | Every (work × collab × run) combination tested for legality; catches regressions deterministically | ✓ |
| Property-based (fast-check) | Random transition generation; asserts invariants hold; supplements exhaustive baseline | |
| Example-based only (happy path + known edge cases) | Fast to write; leaks combinations through guards unchecked | |

**User's choice:** Exhaustive matrix (auto-selected recommended).
**Notes:** The FSM's value is completeness; exhaustive tests protect it. Property-based can be added later as a supplement.

---

## Architectural boundary enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Biome / ESLint import-restriction rule + CI gate | Immediate IDE feedback; fails CI on violation; no new tooling | ✓ |
| Test in `test/unit/` walking imports | Works but reports violations after-the-fact; no IDE feedback | |
| TypeScript `paths` alone | Controls resolution, not intent — `../../../runtime` still works | |

**User's choice:** Lint rule + CI gate (auto-selected recommended).
**Notes:** Chooses whichever of Biome / ESLint already supports the rule in the repo (Biome `noRestrictedImports` or ESLint `no-restricted-imports` / `import/no-restricted-paths`).

---

## Documentation consolidation approach

| Option | Description | Selected |
|--------|-------------|----------|
| Layered — new `docs/foundations/` canonical; existing `docs/architecture/*` linked | Minimal churn; discoverable; canonical layer is thin + authoritative | ✓ |
| In-place rewrite of `docs/architecture/*` | High churn; risks losing detail; mixes canonical + reference | |
| Single `docs/foundations.md` mega-doc | Hard to navigate; becomes stale in chunks | |

**User's choice:** Layered (auto-selected recommended).
**Notes:** Existing architecture docs are thorough; don't rewrite.

---

## Core contracts consolidation tactic

| Option | Description | Selected |
|--------|-------------|----------|
| In-place refactor of existing `src/core/*` | Preserves ~3,300 lines of implementation; adds missing FSM composite guards + tests; low-risk | ✓ |
| Rewrite `core/` from scratch | Discards validated work; high risk | |
| Additive-only (new modules alongside) | Leaves ambiguity about which module is authoritative | |

**User's choice:** In-place refactor (auto-selected recommended).
**Notes:** PROJECT.md stance ("churn allowed but design is sound"); existing `fsm/`, `graph/`, `naming/`, `scheduling/`, `state/`, `warnings/` scaffolding kept and tightened.

---

## Decision-table format for coordination rules

| Option | Description | Selected |
|--------|-------------|----------|
| Markdown tables canonical + optional TypeScript `as const` mirror | PR-reviewable; renders everywhere; typed mirror catches drift | ✓ |
| JSON schema | Machine-verifiable but adds tooling without payoff at this scale | |
| TypeScript `as const` only | Executable and typed; harder to review in docs; loses plain-language column | |

**User's choice:** Markdown canonical + optional TS mirror (auto-selected recommended).
**Notes:** Single source of truth; TS mirror for rules that drive code (scheduling tiers, valid-state matrix).

---

## State diagram scope

| Option | Description | Selected |
|--------|-------------|----------|
| Three per-axis diagrams + composite validity table | Each FSM legible; table enumerates valid (work × collab × run) combos | ✓ |
| One mega-diagram covering all axes | Illegible; too many nodes and edges | |
| Per-axis diagrams only (no composite) | Misses the invalid-combo enumeration that motivates composite guards | |

**User's choice:** Per-axis + composite table (auto-selected recommended).
**Notes:** Composite table doubles as test-data source for the exhaustive-matrix FSM tests.

---

## Newcomer narrative scope

| Option | Description | Selected |
|--------|-------------|----------|
| One ~2k-word end-to-end "prompt → green main" story with inline links | Builds mental model; links handle detail; single file to maintain | ✓ |
| Terse reference-only | Fast but doesn't solve newcomer ramp-up | |
| Multi-chapter structured guide | Thorough but goes stale chapter-by-chapter; high maintenance | |

**User's choice:** ~2k-word narrative (auto-selected recommended).
**Notes:** Framing: follow one prompt through planner → tasks → verify → merge train → main, naming module boundaries as the reader crosses them.

---

## Typed-ID namespace helpers

| Option | Description | Selected |
|--------|-------------|----------|
| Single `core/naming/` module with per-prefix helper + branded-type utility | Centralized; matches existing shape; three prefixes (m-/f-/t-) don't warrant fragmentation | ✓ |
| Per-prefix files (`milestone-ids.ts`, `feature-ids.ts`, `task-ids.ts`) | Fragments a small, cohesive concept | |
| Inline helpers at each call site | Fails "no bypassing" goal; reinvention drifts | |

**User's choice:** Single naming module (auto-selected recommended).
**Notes:** Extend existing `src/core/naming/index.ts`.

---

## Warning rule shape

| Option | Description | Selected |
|--------|-------------|----------|
| Pure functions in `core/warnings/` returning `Warning[]` for a given graph+runs snapshot | Matches architecture (no I/O in core); easy to test | ✓ |
| Side-effecting emitters in orchestrator | Couples rule logic to mutation paths; harder to test | |
| Reactive stream (RxJS-style) | Over-engineered for O(10) rules | |

**User's choice:** Pure functions in core (auto-selected recommended).
**Notes:** Orchestrator calls the rules at end-of-tick and handles emission; core only defines shape.

---

## Claude's Discretion

- Exact file organization within `docs/foundations/` — planner may split by topic or keep single-file.
- Exact naming of the boundary-enforcement rule config key in Biome/ESLint.
- Specific test file layout under `test/unit/core/fsm/` — follow repo conventions.
- Whether the composite-state matrix is a nested map vs flat tuple list in `core/fsm/` — whichever is more readable.
- Exact inline link style in the newcomer narrative (markdown / footnote / §-style).

## Deferred Ideas

- **Doc-vs-code drift check in CI** — belongs to Phase 11.
- **`gvc0 explain` diagnostic CLI** — belongs to Phase 11.
- **Property-based FSM tests (fast-check)** — tightening pass after exhaustive matrix baseline.
- **Auto-generated TS types from markdown decision tables** — defer until tables exceed ~20 rules.
- **Per-milestone model-profile overrides** — already noted as `REQ-CONFIG-V2-02` (v2).
