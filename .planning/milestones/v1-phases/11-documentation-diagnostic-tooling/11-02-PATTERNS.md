# Phase 11: Documentation & Diagnostic Tooling - Pattern Map

**Mapped:** 2026-05-02
**Files analyzed:** 9 new/modified file targets
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `test/unit/docs/state-axes-drift.test.ts` | test | file-I/O + transform | `test/unit/core/fsm/composite-invariants.test.ts` | exact |
| `test/unit/docs/docs-links.test.ts` | test | file-I/O + transform | `test/unit/core/boundary.test.ts` | role-match |
| `test/unit/docs/coordination-rules-drift.test.ts` | test | file-I/O + transform | `test/integration/scheduler-boundary.test.ts` | role-match |
| `test/unit/docs/reference-landing.test.ts` | test | file-I/O + transform | `test/unit/agents/context.test.ts` | role-match |
| `docs/reference/README.md` | documentation landing page | static navigation | `docs/README.md` + `docs/reference/README.md` | exact |
| `docs/foundations/state-axes.md` | documentation canonical state reference | static + generated-table drift target | `docs/foundations/state-axes.md` | exact |
| `docs/foundations/coordination-rules.md` | documentation canonical coordination reference | static decision tables | `docs/foundations/coordination-rules.md` | exact |
| `docs/README.md` / section landing pages | documentation landing page | static navigation | `docs/architecture/README.md`, `docs/operations/README.md`, `docs/foundations/README.md` | exact |
| `package.json` | config | check integration | `package.json` scripts + `vitest.config.ts` include rules | exact |

## Pattern Assignments

### `test/unit/docs/state-axes-drift.test.ts` (test, file-I/O + transform)

**Analog:** `test/unit/core/fsm/composite-invariants.test.ts`

Use this as the main pattern for a generated/static doc drift check that compares the canonical Markdown matrix in `docs/foundations/state-axes.md` to executable FSM expectations.

**Imports pattern** (lines 1-7):
```typescript
import {
  type CollabControl,
  compositeGuard,
  type RunState,
  type WorkControl,
} from '@core/fsm/index';
import { describe, expect, it } from 'vitest';
```

**Generated-domain constants pattern** (lines 40-75):
```typescript
const WORK_VALUES: readonly WorkControl[] = [
  'discussing',
  'researching',
  'planning',
  'executing',
  'executing_repair',
  'ci_check',
  'verifying',
  'awaiting_merge',
  'summarizing',
  'work_complete',
] as const;

const COLLAB_VALUES: readonly CollabControl[] = [
  'none',
  'branch_open',
  'merge_queued',
  'integrating',
  'merged',
  'conflict',
  'cancelled',
] as const;

const RUN_VALUES: readonly RunState[] = [
  'ready',
  'running',
  'retry_await',
  'await_response',
  'await_approval',
  'checkpointed_await_response',
  'checkpointed_await_approval',
  'completed',
] as const;
```

**Executable source-of-truth pattern** (lines 79-162):
```typescript
function isLegalByRules(
  work: WorkControl,
  collab: CollabControl,
  run: RunState,
): boolean {
  // Rule 1
  if (work === 'work_complete' && collab !== 'merged') return false;
  // Rule 2
  if (
    work === 'awaiting_merge' &&
    !(
      collab === 'branch_open' ||
      collab === 'merge_queued' ||
      collab === 'integrating' ||
      collab === 'conflict'
    )
  ) {
    return false;
  }
  // Rule 3
  const activePhases: readonly WorkControl[] = [
    'executing',
    'ci_check',
    'verifying',
    'executing_repair',
    'awaiting_merge',
    'summarizing',
  ];
  if (activePhases.includes(work) && collab === 'none') return false;
  // Rule 4
  if (collab === 'cancelled') {
    const illegalWhenCancelled: readonly WorkControl[] = [
      'executing',
      'ci_check',
      'verifying',
      'executing_repair',
      'awaiting_merge',
      'summarizing',
    ];
    if (illegalWhenCancelled.includes(work)) return false;
  }
  // Rule 5
  if (
    collab === 'merge_queued' &&
    (run === 'await_response' || run === 'checkpointed_await_response')
  ) {
    return false;
  }
```

**Exhaustive test generation pattern** (lines 164-183):
```typescript
describe('compositeGuard exhaustive matrix', () => {
  // Manually enumerate the matrix so each (work × collab × run) combo gets
  // its own `it` block. This produces 10 × 7 × 8 = 560 test cases.
  for (const work of WORK_VALUES) {
    for (const collab of COLLAB_VALUES) {
      for (const run of RUN_VALUES) {
        const expectedLegal = isLegalByRules(work, collab, run);
        it(`(${work} × ${collab} × ${run}) should be ${
          expectedLegal ? 'legal' : 'illegal'
        }`, () => {
          const result = compositeGuard({ work, collab, run });
          expect(result.legal).toBe(expectedLegal);
          if (!result.legal) {
            expect(result.reason.length).toBeGreaterThan(0);
          }
        });
      }
    }
  }
});
```

**Recommended 11-02 implementation pattern:**
- Put doc drift tests under `test/unit/docs/` so they run in `npm run test:unit` and are included by Vitest without config changes.
- Parse only the fenced `<!-- BEGIN MATRIX -->` / `<!-- END MATRIX -->` block from `docs/foundations/state-axes.md`.
- Generate expected rows from the same `WORK_VALUES`, `COLLAB_VALUES`, and `RUN_VALUES` used by executable tests.
- Fail with a focused diff message naming missing, extra, or mismatched rows.
- Keep the docs test read-only: use `readFileSync`/`fs.readFileSync`; do not auto-regenerate docs in tests.

---

### `test/unit/docs/docs-links.test.ts` (test, file-I/O + transform)

**Analog:** `test/unit/core/boundary.test.ts`

Use this for repository-local Markdown link validation and landing-page link checks.

**Imports and filesystem traversal pattern** (lines 1-23):
```typescript
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = 'src/core';
const DISALLOWED_ALIASES = [
  '@runtime',
  '@persistence',
  '@tui',
  '@orchestrator',
  '@agents',
  '@app',
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkTsFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}
```

**Parameterized test pattern** (lines 25-47):
```typescript
describe('src/core architectural boundary', () => {
  const files = walkTsFiles(CORE_ROOT);

  it.each(
    files,
  )('%s does not import from runtime/persistence/tui/orchestrator/agents/app', (file) => {
    const content = readFileSync(file, 'utf8');
    for (const alias of DISALLOWED_ALIASES) {
      const patterns = [
        new RegExp(`from\\s+["']${alias}["']`),
        new RegExp(`from\\s+["']${alias}/`),
        new RegExp(`import\\s*\\(\\s*["']${alias}["']`),
        new RegExp(`import\\s*\\(\\s*["']${alias}/`),
      ];
      for (const pattern of patterns) {
        expect(
          pattern.test(content),
          `${file} must not import from ${alias}* — found match for ${pattern}`,
        ).toBe(false);
      }
    }
  });
});
```

**Recommended 11-02 implementation pattern:**
- Walk `docs/**/*.md`, `ARCHITECTURE.md`, `specs/**/*.md`, and `src/**/README.md` as needed.
- Ignore external links (`http:`, `https:`, `mailto:`) and in-page anchors unless anchor validation is explicitly in scope.
- Resolve relative links from the Markdown file’s directory with `path.resolve(path.dirname(file), hrefWithoutAnchor)`.
- For `../src/...` and `../../test/...` links, assert the referenced file exists.
- Make failures concrete: `docs/reference/README.md links to missing ./foo.md`.

---

### `test/unit/docs/coordination-rules-drift.test.ts` (test, file-I/O + transform)

**Analog:** `test/integration/scheduler-boundary.test.ts` with `test/integration/scheduler-boundary-allowlist.json`

Use this for static drift checks that need a small parser plus a checked allowlist or section inventory. Place the new doc drift test in `test/unit/docs/`, not `test/integration/`, unless it requires subprocesses or slow integration fixtures.

**Imports and repo-root resolution pattern** (lines 1-5, 68-75):
```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST_PATH = path.join(
  __dirname,
  'scheduler-boundary-allowlist.json',
);
```

For a unit test under `test/unit/docs/`, `REPO_ROOT` should resolve three levels up:
```typescript
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
```

**Static schema pattern** (lines 51-67):
```typescript
interface AllowlistEntry {
  methods: string[];
  reason: string;
}

interface AllowlistSchema {
  scanned_files: string[];
  allowlist: Record<string, AllowlistEntry[]>;
}

interface MutationSite {
  file: string;
  method: string;
  line: number;
  column: number;
}
```

**Load JSON / static fixture pattern** (lines 76-79):
```typescript
function loadAllowlist(): AllowlistSchema {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
  return JSON.parse(raw) as AllowlistSchema;
}
```

**Violation formatting pattern** (lines 173-186):
```typescript
if (violations.length > 0) {
  const formatted = violations
    .map(
      (v) =>
        `  ${v.file}:${v.line}:${v.column} — direct mutation graph.${v.method}() — route through schedulerRef.current?.enqueue(...) or add to allowlist with justification`,
    )
    .join('\n');
  throw new Error(
    `\nScheduler boundary violation — ${violations.length} direct graph mutation(s) found in scanned files:\n${formatted}\n`,
  );
}

expect(violations.length).toBe(0);
```

**Static allowlist fixture pattern** (`test/integration/scheduler-boundary-allowlist.json` lines 1-7):
```json
{
  "_comment": "Plan 04-01 Task 3: enumerated call sites permitted to mutate the FeatureGraph outside the scheduler's event queue. Every NEW direct mutation from src/ must either land in an allowlisted file below or be refactored to route through schedulerRef.current?.enqueue(...). The walker only scans the files listed in `scanned_files`; everything else is considered out-of-scope for this plan.",

  "scanned_files": ["src/compose.ts", "src/agents/runtime.ts"],

  "allowlist": {
```

**Recommended 11-02 implementation pattern:**
- Prefer hard-coded inventories in the test for canonical docs that must exist (`state-axes.md`, `execution-flow.md`, `coordination-rules.md`, `newcomer.md`) unless user-editable allowlists are needed.
- If using an allowlist JSON, keep it next to the test and include a `_comment` explaining when to add/remove entries.
- Validate the allowlist is live: assert each scanned Markdown file exists and each allowlisted section/link is still present.
- Use this approach for checks like “coordination rule families in docs match expected headings and source-of-truth subsections.”

---

### `test/unit/docs/reference-landing.test.ts` (test, file-I/O + transform)

**Analog:** `test/unit/agents/context.test.ts`

Use this for focused tests that assert docs include expected carry-forward sections or navigation entries without a large filesystem walker.

**Imports and fixture-helper pattern** (lines 1-13, 15-24):
```typescript
import {
  buildDiscussContext,
  buildPlanContext,
  buildResearchContext,
  buildSummarizeContext,
  buildVerifyContext,
} from '@agents/context';
import type { Feature, Task } from '@core/types/index';
import { describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function featureWithPhaseOutputs(overrides: Partial<Feature> = {}): Feature {
  return createFeatureFixture({
    roughDraft: 'draft v1',
    discussOutput: '## Success Criteria\n- only email',
    researchOutput: '## Essential Files\n- `bcrypt-js`',
    featureObjective: 'ship login',
    featureDoD: ['login works', 'tests green'],
    ...overrides,
  });
}
```

**Positive and negative assertion pattern** (lines 50-57):
```typescript
it('buildPlanContext carries draft + discuss + research markdown', () => {
  const feature = featureWithPhaseOutputs();
  const ctx = buildPlanContext(feature);
  expect(ctx.roughDraft).toBe('draft v1');
  expect(ctx.discussOutput).toContain('only email');
  expect(ctx.researchOutput).toContain('bcrypt-js');
});
```

**Recommended 11-02 implementation pattern:**
- For `docs/reference/README.md`, assert it contains required bullets for TUI, Knowledge Files, Codebase Map, and any new diagnostics/explain page added by 11-02.
- Assert it does not become a full catalog; it should remain “user-facing surfaces and orientation material” per the current reference landing page.
- Keep tests semantic (`toContain('[Explain Diagnostics](./explain.md)')`) rather than snapshotting whole Markdown files.

---

### `docs/reference/README.md` (documentation landing page, static navigation)

**Analogs:** `docs/reference/README.md`, `docs/README.md`, `docs/reference/codebase-map.md`

Use the existing reference landing-page style: one short purpose paragraph and a concise bullet list, not a long catalog.

**Current reference landing pattern** (`docs/reference/README.md` lines 1-9):
```markdown
# Reference Topics

Reference pages collect user-facing surfaces and orientation material rather than core state-machine rules.
Use them when you need UI behavior, context-file behavior, or quick pointers into codebase.

- [TUI](./tui.md) — terminal UI conventions, overlays, and keyboard actions.
- [Knowledge Files](./knowledge-files.md) — `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md` append-only files and how task prompts cite them via planner-baked `references`.
- [Codebase Map](./codebase-map.md) — docs index of source-area README files under `src/`.
```

**Top-level docs index pattern** (`docs/README.md` lines 3-14):
```markdown
## Foundations (start here)

- [Foundations](./foundations/README.md) — Canonical state, flow, and coordination docs — the layer newcomers should read first.

Use these entry points depending on what you need:

- [Architecture Overview](../ARCHITECTURE.md) — system thesis, lifecycle split, and component map.
- [Architecture Topics](./architecture/README.md) — canonical model and architecture details.
- [Operations Topics](./operations/README.md) — verification, recovery, conflict coordination, warnings, and testing strategy.
- [Reference Topics](./reference/README.md) — TUI behavior, context/knowledge inputs, and source-area README pointers.
- [Agent Prompts](./agent-prompts/README.md) — live-source prompt references for discuss, research, plan, execute, verify, and summarize agents, plus copied upstream references.
- [Scenario Specs](../specs/README.md) — grouped markdown scenario inventory for later executable tests.
```

**Codebase pointer style** (`docs/reference/codebase-map.md` lines 1-8):
```markdown
# Codebase Map

This page points to code-local README files under `src/`. Use it when you already know which subsystem you are editing and want nearest boundary description.

This docs page is separate from any runtime `codebaseMap` prompt string. See [Knowledge Files](./knowledge-files.md) for current context-input wiring.

Start with [ARCHITECTURE.md](../../ARCHITECTURE.md) for system-wide map, then jump to source-area README that matches code you are touching.
```

**Recommended 11-02 implementation pattern:**
- If adding an explain/diagnostics reference page, add one bullet to `docs/reference/README.md` and one bullet to the `## Reference` section in `docs/README.md`.
- Do not duplicate state-machine rules here; link to `docs/foundations/state-axes.md` and `docs/foundations/coordination-rules.md` for canonical semantics.
- Keep descriptions in the “link — short purpose” style.

---

### `docs/foundations/state-axes.md` (documentation canonical state reference, static + generated-table drift target)

**Analog:** `docs/foundations/state-axes.md`

This file is already the canonical state-axis doc. 11-02 should preserve its structure and add tests around the existing drift-check contract.

**Canonical purpose pattern** (lines 1-20):
```markdown
# State Axes

gvc0 splits feature state across three axes instead of collapsing them into
one enum:

- **work control** — planning and execution phase progression
- **collaboration control** — branch / merge / conflict coordination
- **run state** — the per-`agent_runs` disposition (retry windows, help /
  approval waits, terminal outcomes)

This split is deliberate. A single enum would blur orthogonal concerns: a
feature can be _executing_ (work) on a _branch_open_ collab axis with an
individual run in _retry_await_ — three independent facts that each evolve on
their own timeline. The cross-axis invariants that tie them together live in
[`compositeGuard`](../../src/core/fsm/index.ts) and are enumerated below.
```

**Generated/static table marker pattern** (lines 168-173, 591-593):
```markdown
### Composite validity matrix

<!-- BEGIN MATRIX -->
| work | collab | run | legal? | reason-if-illegal |
| ---- | ------ | --- | ------ | ----------------- |
| discussing | none | ready | yes |  |
```

```markdown
| work_complete | cancelled | await_approval | no | Rule 1: work_complete requires collab=merged |
| work_complete | cancelled | completed | no | Rule 1: work_complete requires collab=merged |
<!-- END MATRIX -->
```

**Drift-check contract pattern** (lines 652-660):
```markdown
## Drift-check note

If this table disagrees with
[`test/unit/core/fsm/composite-invariants.test.ts`](../../test/unit/core/fsm/composite-invariants.test.ts),
**the test wins**. The canonical runtime shape is in
[`src/core/fsm/index.ts`](../../src/core/fsm/index.ts). Phase 11 will add a
CI check that parses this table and compares it to the test's
`isLegalByRules` output. Until then, any changes to either side should update
both in the same commit.
```

**Recommended 11-02 implementation pattern:**
- Change the drift-check note from future tense to current tense after adding `test/unit/docs/state-axes-drift.test.ts`.
- If docs are updated, preserve `<!-- BEGIN MATRIX -->` / `<!-- END MATRIX -->` markers because they are the stable parse seam.
- Align docs with current code: `AgentRunStatus` now includes checkpointed wait states in tests (`checkpointed_await_response`, `checkpointed_await_approval`), so the matrix/test drift check should expose any stale 10 × 7 × 6 cardinality claims.

---

### `docs/foundations/coordination-rules.md` (documentation canonical coordination reference, static decision tables)

**Analog:** `docs/foundations/coordination-rules.md`

Use the existing decision-table structure for coordination docs and validate that every rule family keeps a “Source of truth” section.

**Canonical table-over-prose rule** (lines 1-17):
```markdown
# Coordination Rules

Decision tables for the coordination rule families that govern
lock / claim / suspend / resume / rebase behavior in gvc0.

This layer is canonical: tables are canonical, and
[../operations/conflict-coordination.md](../operations/conflict-coordination.md)
is kept as the narrative reference. If the two disagree, update the narrative
to match the table rather than the other way around.

Each family below has:

- A one-paragraph intent statement
- At least one Markdown decision table
- A "Source of truth" subsection naming the module / function where the rule
  lives in code
```

**Decision-table pattern** (lines 27-35):
```markdown
### Lock — write pre-hook path claim

| scenario | path already locked? | same feature? | action | outcome |
| -------- | -------------------- | ------------- | ------ | ------- |
| path free | no | n/a | grant the lock; attach holder `<task_id>` | write proceeds immediately |
| path locked by same task (re-entrant write) | yes | same task | grant (no-op) | write proceeds; lock already held |
| path locked by another task in same feature | yes | same feature, different task | route to same-feature coordination (see [Suspend](#suspend)) | lower-priority task suspended; higher-priority continues |
| path locked by a task in a different feature | yes | different feature | route to cross-feature coordination (see [Claim](#claim) + [Suspend](#suspend)) | secondary feature's tasks suspended; primary continues |
| path locked by a task in a cancelled feature | yes | cancelled holder | ignore stale holder; grant the lock | write proceeds; stale lock reclaimed |
```

**Source-of-truth pattern** (lines 46-53):
```markdown
### Source of truth

- Runtime claim round-trip in the worker: see the write-prehook documented in
  [../architecture/worker-model.md](../architecture/worker-model.md) and the
  IPC `claim_lock` message.
- Orchestrator-side ActiveLocks registry: `src/orchestrator/` (`ActiveLocks`
  runtime path registry).
- Release-on-exit policy: `src/orchestrator/` task-exit handler.
```

**Recommended 11-02 implementation pattern:**
- For static drift tests, assert the required top-level families exist: `Lock`, `Claim`, `Suspend`, `Resume`, `Rebase`, `Re-entry`.
- Assert each family contains at least one Markdown table and a `### Source of truth` subsection before the next `---` separator.
- Cross-link `docs/operations/conflict-coordination.md` only as narrative; the table doc remains canonical.

---

### `docs/README.md` / section landing pages (documentation landing page, static navigation)

**Analogs:** `docs/foundations/README.md`, `docs/architecture/README.md`, `docs/operations/README.md`

Use section landing pages as concise entry points. Do not turn a single landing page into the whole catalog.

**Foundations landing pattern** (`docs/foundations/README.md` lines 1-20):
```markdown
# Foundations

This layer answers the three questions that have historically been hardest to
reason about in gvc0: (1) what state is the system in, (2) who triggers what
when, (3) how do coordination rules (lock/claim/suspend/resume/rebase) actually
decide what happens. Each document here is authoritative; linked
`docs/architecture/*` pages remain the detail reference. When prose and a
decision table disagree, the table wins.

## The four canonical docs

- [state-axes.md](./state-axes.md) — the three FSM axes (work, collab, run)
  plus the composite validity matrix enforced by `compositeGuard`.
- [execution-flow.md](./execution-flow.md) — who triggers what, when, across
  TUI, Orchestrator, Scheduler, Worker Pool, and the merge train.
- [coordination-rules.md](./coordination-rules.md) — decision tables for the
  lock / claim / suspend / resume / rebase / re-entry rule families.
- [newcomer.md](./newcomer.md) — one end-to-end narrative from "the user types
  a prompt" to "a commit lands on main". Start here if this is your first look.
```

**Architecture landing pattern** (`docs/architecture/README.md` lines 1-10):
```markdown
# Architecture Topics

Use [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level system map. Use the pages below for the canonical architecture details.

- [Data Model](./data-model.md) — milestones, features, tasks, work control, collaboration control, run state, and derived summary availability.
- [Graph Operations](./graph-operations.md) — DAG mutations, scheduling rules, milestone steering, and merge-train coordination.
- [Worker Model](./worker-model.md) — process-per-task execution, worktrees, IPC, context assembly, and crash recovery.
- [Persistence](./persistence.md) — SQLite schema, authoritative state, and JSON-vs-column boundaries.
- [Planner](./planner.md) — planner tool workflow and write-reservation heuristics.
- [Budget and Model Routing](./budget-and-model-routing.md) — budget ceilings, routing tiers, and token profiles.
```

**Operations landing pattern** (`docs/operations/README.md` lines 1-9):
```markdown
# Operations Topics

Use these pages for runtime behavior, recovery rules, and operator-facing coordination details.
These are the main references when you are reasoning about retries, verification, blocking, or conflict handling.

- [Verification and Recovery](./verification-and-recovery.md) — retries, verification layers, stuck handling, replanning, and merge-train recovery.
- [Conflict Coordination](./conflict-coordination.md) — steering ladder, same-feature overlap handling, and cross-feature coordination policy.
- [Warnings](./warnings.md) — advisory signals for budget pressure, slow checks, blocking, and churn.
- [Testing Strategy](./testing.md) — unit/integration testing approach and faux-provider guidance.
```

**Recommended 11-02 implementation pattern:**
- Update only the landing pages whose section inventory changes.
- Keep the top-level `docs/README.md` as a routing page with suggested reading paths and section entry points.
- Keep canonical state and coordination docs in `docs/foundations/`; keep diagnostic CLI reference material in `docs/reference/`.

---

### `package.json` (config, check integration)

**Analogs:** `package.json`, `vitest.config.ts`, `tsconfig.json`

Use existing `npm run check` integration and Vitest placement before adding new scripts. Since doc drift tests can live under `test/unit/**/*.test.ts`, they should already run through `npm run test`, `npm run test:unit`, and `npm run check` without adding a separate script.

**Existing scripts pattern** (`package.json` lines 10-28):
```json
"scripts": {
  "check": "npm run check:fix; npm run format:check && npm run lint && npm run typecheck && npm run test",
  "check:fix": "biome check --write .",
  "fix": "npm run check:fix",
  "format": "biome format --write .",
  "format:check": "biome check --formatter-enabled=true --linter-enabled=false .",
  "lint": "biome check --formatter-enabled=false --linter-enabled=true .",
  "lint:fix": "npm run check:fix",
  "lint:ci": "eslint \"src/**/*.ts\" \"test/**/*.ts\" \"vitest.config.ts\" --max-warnings=0 --no-error-on-unmatched-pattern --cache",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:unit": "vitest run test/unit",
  "test:unit:watch": "vitest test/unit",
  "test:integration": "vitest run test/integration",
  "test:integration:watch": "vitest test/integration",
  "test:tui:e2e": "command npx tui-test",
  "tui": "tsx src/main.ts",
  "typecheck": "tsc --noEmit",
  "verify": "npm run check && npm run lint:ci"
}
```

**Vitest include pattern** (`vitest.config.ts` lines 7-18):
```typescript
test: {
  environment: 'node',
  globals: false,
  passWithNoTests: true,
  include: [
    'test/unit/**/*.test.ts',
    'test/unit/**/*.spec.ts',
    'test/integration/**/*.test.ts',
    'test/integration/**/*.spec.ts',
  ],
  exclude: ['test/integration/tui/**'],
},
```

**TypeScript test inclusion pattern** (`tsconfig.json` lines 44-47):
```json
"types": ["node"]
},
"include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
"exclude": ["node_modules", "dist", "coverage"]
```

**Recommended 11-02 implementation pattern:**
- Prefer `test/unit/docs/*.test.ts` so existing `vitest.config.ts` and `tsconfig.json` pick up the checks automatically.
- Do not add a custom `scripts/` directory just to run Markdown drift checks unless a generator is explicitly needed.
- If adding a script becomes necessary, wire it into `check` before or after `test` and keep `verify` as `npm run check && npm run lint:ci`.
- Remember `check` currently runs `check:fix` first; doc drift tests must not rely on source files staying unformatted in a particular way outside Markdown tables/markers.

## Shared Patterns

### Documentation canonicality hierarchy
**Source:** `docs/foundations/README.md`, `docs/foundations/state-axes.md`, `docs/foundations/coordination-rules.md`
**Apply to:** all 11-02 docs and drift tests

Use this hierarchy:
1. Runtime source and executable tests are the final truth for state and code behavior.
2. `docs/foundations/*` are canonical summaries for state, flow, and coordination.
3. `docs/architecture/*` and `docs/operations/*` are detail/narrative references.
4. `docs/reference/*` are user-facing surfaces and orientation pages.

Concrete source lines:
```markdown
If this table disagrees with
[`test/unit/core/fsm/composite-invariants.test.ts`](../../test/unit/core/fsm/composite-invariants.test.ts),
**the test wins**. The canonical runtime shape is in
[`src/core/fsm/index.ts`](../../src/core/fsm/index.ts).
```
`docs/foundations/state-axes.md` lines 652-657.

### Test placement
**Source:** `CLAUDE.md`, `vitest.config.ts`, `package.json`
**Apply to:** all doc validation/drift checks

- Unit-level static Markdown checks belong in `test/unit/docs/**/*.test.ts`.
- Integration tests are for real orchestrator/runtime flows, subprocesses, persistence migration scenarios, or faux-model agent loops.
- Existing commands already include doc tests if placed under `test/unit`.

### File I/O in tests
**Source:** `test/unit/core/boundary.test.ts`, `test/integration/scheduler-boundary.test.ts`
**Apply to:** docs link checks, table checks, static drift checks

Use Node built-ins directly:
```typescript
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
```
Or, where ESM `__dirname` is needed:
```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

### Error formatting in drift checks
**Source:** `test/integration/scheduler-boundary.test.ts` lines 173-182
**Apply to:** generated/static drift checks

Format all violations together and throw one actionable error. Do not stop at the first mismatch unless the parser cannot continue.

### Markdown docs style
**Source:** `docs/README.md`, `docs/foundations/README.md`, `docs/reference/README.md`
**Apply to:** all documentation updates

- Use relative Markdown links.
- Use short landing-page descriptions: `[Title](./file.md) — purpose.`
- Use Mermaid for diagrams and Markdown tables for decision rules.
- Do not duplicate detailed architecture rules in reference pages.
- Prefer source-of-truth links in canonical docs.

## No Analog Found

All requested 11-02 file categories have usable analogs in the current codebase.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| n/a | n/a | n/a | Existing docs, Vitest static checks, generated matrix tests, package scripts, and landing pages provide sufficient patterns. |

## Metadata

**Analog search scope:** `/home/alpine/vcode0/docs`, `/home/alpine/vcode0/test`, `/home/alpine/vcode0/package.json`, `/home/alpine/vcode0/vitest.config.ts`, `/home/alpine/vcode0/tsconfig.json`
**Files scanned:** 30+ docs/test/config files from `docs/**`, `test/unit/**`, `test/integration/**`, root config files
**Pattern extraction date:** 2026-05-02
