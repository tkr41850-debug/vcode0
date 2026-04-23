# Phase 1: Foundations & Clarity - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning
**Mode:** `--auto` (recommended options selected without interactive prompts; rationale logged inline)

<domain>
## Phase Boundary

Phase 1 delivers the **crisp core contracts + canonical documentation** that downstream phases will build on. Scope:

- Audit and close gaps in `src/core/*` — types, graph invariants, FSM guards (including composite cross-axis invariants), scheduling rules, naming utilities, warnings — so the `core/` module is the pure, authoritative source of project contracts.
- Enforce the architectural boundary: `@core/*` imports nothing from `@runtime/*`, `@persistence/*`, or `@tui/*`, checked in CI.
- Publish canonical documentation that matches shipped code: one state diagram covering work × collab × run axes, execution-flow narrative, and coordination-rule decision tables — plus a newcomer end-to-end narrative.
- Provide the unit-test backbone for FSM composite invariants so later phases land on a tested foundation.

**Not in scope for this phase**: persistence, runtime, worker processes, scheduler tick loop, merge train logic, agents, TUI. All of those consume Phase 1's contracts in later phases.
</domain>

<decisions>
## Implementation Decisions

### D-01: State-diagram authoring format — **Mermaid in markdown**
[--auto] Selected recommended option from: Mermaid / ASCII art / External tool (PlantUML / draw.io).
**Why:** Renders natively on GitHub and in docs preview, is editable as plain text, diff-friendly, and keeps the single source of truth in the repo. ASCII art (current convention in ARCHITECTURE.md) is fine for small overviews but becomes unreadable for the three-axis composite diagram. External tools add a toolchain that ages poorly.

### D-02: FSM unit-test strategy — **Exhaustive state-matrix enumeration + invariant tests**
[--auto] Selected recommended option from: exhaustive matrix / property-based (fast-check) / example-based only.
**Why:** The FSM's value is its *completeness guarantee* — every (work × collab × run) combination either transitions legally or is explicitly rejected. Exhaustive matrix tests catch regressions deterministically. Property-based testing can come later as a supplement once the matrix baseline exists. Example-based alone leaks combinations through the guards unchecked.

### D-03: Architectural boundary enforcement — **Biome / ESLint import-restriction rule + CI gate**
[--auto] Selected recommended option from: Biome/ESLint rule / walk-imports test / TypeScript paths alone.
**Why:** Biome has `noRestrictedImports`; ESLint has `no-restricted-imports` / `import/no-restricted-paths`. Either gives immediate IDE feedback + fails CI — much better UX than a test that reports violations after-the-fact. TypeScript `paths` is weak: it controls resolution but not intent (`../../../runtime` still works). The rule is added to whichever linter already has the rule wired; no new tooling to introduce.

### D-04: Documentation consolidation approach — **Layered — new `docs/foundations/` canonical layer; existing `docs/architecture/*` remains and is cross-linked**
[--auto] Selected recommended option from: layered / in-place rewrite of docs/architecture/* / single mega-doc.
**Why:** Existing `docs/architecture/*` is already thorough; rewriting in place risks losing detail. A new `docs/foundations/` layer holds the *canonical* artifacts (the one state diagram, the one execution-flow narrative, the decision tables, the newcomer narrative) and cross-links down to `docs/architecture/*` for detail. Minimizes churn, maximizes discoverability for newcomers.

### D-05: Core contracts consolidation tactic — **In-place refactor of existing `src/core/*`**
[--auto] Selected recommended option from: in-place refactor / rewrite from scratch / additive-only alongside existing.
**Why:** `src/core/*` already has `fsm/`, `graph/`, `merge-train/`, `naming/`, `proposals/`, `scheduling/`, `state/`, `types/`, `warnings/` — ~3,300 lines of implementation. User's stance is "churn allowed but design is directionally sound." In-place refactor keeps momentum: identify gaps in FSM composite guards and naming utilities, add missing tests, tighten types. Rewriting would discard validated work. Additive-only leaves ambiguity about which module is authoritative.

### D-06: Decision-table format for coordination rules — **Markdown tables canonical; optional TypeScript `as const` mirror in `core/` where rules drive code**
[--auto] Selected recommended option from: markdown tables / JSON schema / TypeScript `as const`.
**Why:** Markdown tables are reviewable in PRs, render everywhere, and accept the full range of human-readable rules. For rules that also drive code (scheduling priority tiers, valid composite-state matrix), mirror the same rows as a typed `as const` in `core/` so doc-vs-code drift is caught by tests. Avoid JSON schema — adds tooling without a payoff at this scale.

### D-07: State diagram scope — **Three individual per-axis diagrams + one composite "valid-combination matrix" table**
[--auto] Selected recommended option from: one mega-diagram / per-axis diagrams + composite table / per-axis only.
**Why:** One mega-diagram is illegible. Per-axis diagrams show each FSM cleanly; a composite table enumerates which (work × collab × run) combinations are valid and which the guards forbid. The table is also the test-data source for D-02's exhaustive matrix — one artifact serves both docs and tests.

### D-08: Newcomer narrative scope — **One end-to-end "prompt → green main" story, ~2k words, with inline links to canonical refs**
[--auto] Selected recommended option from: 2k-word narrative / terse reference-only / multi-chapter guide.
**Why:** Newcomer pain is "I can't trace the flow without reading source." A single 2k-word narrative following one prompt through planner → tasks → verify → merge-train → main gives a mental model; links handle detail. Multi-chapter guides get out of date; terse refs don't solve the initial ramp-up problem.

### D-09: Typed-ID namespace helpers — **Single `core/naming/` module with one helper per prefix + a branded-type utility**
[--auto] Selected recommended option from: one naming module / per-prefix files / inline helpers.
**Why:** `src/core/naming/index.ts` already exists; extend it. Centralized naming is the right level of granularity for three prefixes (`m-`, `f-`, `t-`). Per-prefix files fragment; inline helpers fail the "no bypassing" goal when someone needs to construct an ID elsewhere.

### D-10: Warning rules — **Keep in `core/warnings/`; each rule is a pure function returning `Warning[]` for a given graph + runs snapshot**
[--auto] Selected recommended option from: pure functions in core / side-effecting emitters in orchestrator / reactive stream.
**Why:** Pure functions match the architecture (no I/O in core). Side-effecting emitters couple warning generation to orchestrator mutation paths. Reactive stream is over-engineered for O(10) warning rules. Warnings run at end-of-tick in orchestrator; the core only defines the rules.

### Claude's Discretion

- Exact file organization within `docs/foundations/` (single file, split by topic, etc.) — planner can pick what fits the content best.
- Exact naming of the boundary-enforcement rule config key in Biome/ESLint — standard convention applies.
- Specific test file layout under `test/unit/core/fsm/` — follow existing conventions (one test file per FSM axis, plus a composite-matrix test file).
- Whether the composite-state matrix is encoded as a nested map or flat tuple list in `core/fsm/` — whichever is more readable given the valid-combination count.
- Exact inline link style in the newcomer narrative (markdown links, footnote-style, or `§`-style section refs).

### Folded Todos

None — no pending todos at project initialization.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing Phase 1.**

### Project-level direction (always load)
- `.planning/PROJECT.md` — decisions, core value, constraints, key decisions table
- `.planning/REQUIREMENTS.md` — the 37 v1 REQ-ids and traceability to phases
- `.planning/ROADMAP.md` — phase-1 goal and success criteria
- `.planning/STATE.md` — current position and accumulated concerns
- `.planning/research/SUMMARY.md` — v1 phase rationale (Phase 1 section is load-bearing for this CONTEXT)
- `.planning/research/ARCHITECTURE.md` — validation of the existing design (keep / revise / spike)
- `.planning/research/PITFALLS.md` §Pitfall 12 (state-axis divergence) — motivation for composite FSM invariants

### Repo-level conventions
- `CLAUDE.md` — TypeScript strictness, Biome/ESLint setup, path aliases, testing conventions
- `ARCHITECTURE.md` — existing design thesis (kept; new docs link to this)

### In-tree architecture docs (the canonical layer will link down to these; they remain authoritative on detail)
- `docs/README.md` — docs landing
- `docs/architecture/README.md` — architecture topic index
- `docs/architecture/data-model.md` — state axes + entity shapes
- `docs/architecture/graph-operations.md` — graph mutations, FSM transitions, scheduler pseudocode, priority tiers
- `docs/architecture/worker-model.md` — worker / IPC / crash recovery shape
- `docs/architecture/planner.md` — agent-phase contracts
- `docs/architecture/persistence.md` — SQLite schema + migrations conceptual shape
- `docs/architecture/budget-and-model-routing.md` — per-role model config shape
- `docs/operations/verification-and-recovery.md`
- `docs/operations/conflict-coordination.md` — lock/claim/suspend/resume/rebase rules (Phase 1 distills these into decision tables)
- `docs/operations/warnings.md` — warning rule catalog
- `docs/reference/README.md` — TUI + knowledge inputs + codebase pointers

### In-tree specs that bound Phase 1 contracts
- `specs/README.md`
- `specs/test_graph_invariants.md` — DAG invariants Phase 1's `core/graph/validation.ts` must preserve
- `specs/test_graph_contracts.md` — graph operation contracts
- `specs/test_agent_run_wait_states.md` — run-state axis semantics
- `specs/test_scheduler_frontier_priority.md` — scheduling rules
- `specs/test_package_boundary_contracts.md` — boundary check contract Phase 1 must enforce
- `specs/test_runtime_session_contracts.md` — runtime contracts bounding what `core/` exposes

### Existing `src/core/*` files touched in this phase
- `src/core/README.md` — current intent doc
- `src/core/fsm/index.ts` — current FSM guards (audit + extend for composite invariants)
- `src/core/state/index.ts` — state-type declarations
- `src/core/graph/` — types, validation, mutations (audit for invariant coverage)
- `src/core/naming/index.ts` — typed-ID helpers (D-09)
- `src/core/scheduling/` — priority rules
- `src/core/warnings/` — warning rules (D-10)

### Tooling references
- `biome.json` (or `biome.jsonc`) — add import-restriction rule per D-03 if Biome is the host
- `.eslintrc*` — alternative host for the rule if ESLint covers it (see repo root for the actual file)
- `package.json` → `npm run typecheck` / `npm run lint` / `npm run test` — CI integration points

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/core/fsm/index.ts` (512 lines)** — existing FSM scaffolding; Phase 1 audits for composite invariants and fills gaps. Not a rewrite.
- **`src/core/graph/*`** — comprehensive existing implementation (types, mutations, queries, validation, transitions). Phase 1 ensures validation + transitions cover composite invariants and every mutation preserves DAG constraints from `docs/architecture/graph-operations.md`.
- **`src/core/naming/index.ts`** — typed prefix helpers (m-/f-/t-); extend per D-09 if incomplete.
- **`src/core/scheduling/*`** — priority rules and combined-graph logic already partly in place; Phase 1 ensures parity with decision tables.
- **`src/core/warnings/*`** — warning rules already scaffolded; Phase 1 tightens to pure functions per D-10.
- **`@sinclair/typebox`** — available for runtime schemas (IPC, config, tool schemas); Phase 1 uses it where core types need runtime validation (e.g., proposal envelopes).

### Established Patterns
- **TypeScript strict mode** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — all new core code must compile under these.
- **Path aliases** (`@core/*`, `@runtime/*`, etc.) via `tsconfig` and `vitest tsconfigPaths: true` — Phase 1's boundary rule uses these aliases.
- **ES modules / NodeNext resolution** — imports use `.js` extensions in source when required; Phase 1 doesn't change this.
- **Vitest test split** between `test/unit/*` (pure, no spawn/IPC) and `test/integration/*` (fauxModel + real processes); Phase 1 tests live under `test/unit/core/`.
- **Biome-first formatting + linting**; ESLint covers type-aware rules via `lint:ci`. Phase 1 picks the host that already supports `noRestrictedImports` / `no-restricted-paths`.

### Integration Points
- **CI integration** — `npm run check` and `npm run verify` are the quality gates; the boundary-enforcement rule must fail `check` on violation so Phase 1's guard is load-bearing, not advisory.
- **Newcomer narrative** cross-references `docs/architecture/*` — don't rewrite those, link.
- **Composite-state matrix** encoded in both markdown (for the decision table in `docs/foundations/`) and `core/fsm/` (for runtime enforcement + tests) — single source of truth needed; Phase 1 picks one, generates the other.

### Existing Brownfield Concerns (keep in mind during planning)
- PROJECT.md + PITFALLS.md flag state-axis divergence as a critical pitfall. Phase 1's composite FSM invariants are the primary mitigation.
- `docs/concerns/planner-write-reservation-accuracy.md` is related but addresses Phase 3+4; Phase 1 only sets up the types/invariants, not enforcement.
- `docs/operations/conflict-coordination.md` is prose-heavy; Phase 1 distills it into decision tables per D-06. If the prose and the table disagree, the table wins (and the prose gets updated).

</code_context>

<specifics>
## Specific Ideas

- **State diagram layout**: three side-by-side per-axis diagrams at the top of the canonical state doc (work / collab / run), followed by a composite-validity table below. This is the user's memory pattern for "make the state readable at a glance."
- **Boundary rule message**: when a violation triggers, the linter message should say "core/ must not import from @runtime/* | @persistence/* | @tui/*" — descriptive enough that a new contributor understands the architectural reason.
- **Newcomer narrative framing**: start from "the user types a prompt and presses enter" and follow the event all the way to a green `main`, naming the module boundaries as the reader passes each one. Do not start from "here are the layers." The narrative IS the discovery path.
- **Composite-state test file name convention**: `test/unit/core/fsm/composite-invariants.test.ts` — recognizable from a glance.
- **Warning rule docstrings**: each pure warning rule function in `core/warnings/*` gets a one-line JSDoc stating the observable situation it detects (e.g., `"@warns merge-train re-entry count approaching cap"`). Phase 11 doc-vs-code drift check will read these.

</specifics>

<deferred>
## Deferred Ideas

### Reviewed Todos (not folded)
None — no todos existed at project initialization.

### Ideas surfaced during analysis, deferred to later phases
- **Doc-vs-code drift check in CI** — mentioned in Phase 11 success criteria; Phase 1 produces the docs, Phase 11 adds the drift check tooling.
- **`gvc0 explain` diagnostic CLI** — belongs to Phase 11; Phase 1 produces the canonical shapes the CLI will render.
- **Property-based FSM tests** (fast-check) — defer to a later tightening pass once the exhaustive matrix is in place.
- **Auto-generated TypeScript types from the markdown decision tables** — interesting but adds tooling that isn't justified at this scale; reconsider if tables grow beyond ~20 rules.
- **Per-milestone model-profile overrides** — already noted in PROJECT.md as `REQ-CONFIG-V2-02` (v2); not touched in Phase 1.

</deferred>

---

*Phase: 01-foundations-clarity*
*Context gathered: 2026-04-23 (auto-mode)*
