# CLAUDE.md

Guide for Claude Code (claude.ai/code) when working in this repo.

## Project Overview

**gvc0** = TypeScript remake of GSD-2 on pi-sdk (`@mariozechner/pi-agent-core`). DAG-first autonomous agent orchestration. Max parallelism at every level. System use feature DAG with task DAGs local to each feature branch. Collaboration with `main` go through serialized merge train.

Core thesis: DAG only execution model. Features depend only on features. Tasks depend only on tasks in same feature. Work progress tracked through work control phases. Branch/merge/conflict coordination tracked separately through collaboration control states.

## Essential Commands

```bash
# Full verification (format, lint, typecheck, test)
npm run check

# Extended verification (includes lint:ci)
npm run verify

# Run all tests
npm run test

# Run all tests in watch mode
npm run test:watch

# Run only unit tests
npm run test:unit
npm run test:unit:watch

# Run only integration tests
npm run test:integration
npm run test:integration:watch

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:check
```

## Architecture

Single root TypeScript package, not monorepo. Boundaries under `src/` with TS path aliases:

- `@app/*` - App lifecycle and startup
- `@core/*` - Pure domain logic (graph/state types, scheduling rules, warnings)
- `@orchestrator/*` - Service layer (scheduler, feature lifecycle, conflicts, summaries)
- `@agents/*` - Planner and replanner agents with prompts and tools
- `@runtime/*` - Worker pool, IPC, harness, context assembly
- `@persistence/*` - SQLite implementation with better-sqlite3
- `@tui/*` - Terminal UI components and view models

### Execution Model

- **Process-per-task**: Each task spawn child process running pi-sdk `Agent` in isolated git worktree
- **Feature branches**: Each feature own one long-lived integration branch (`feat-<name>-<feature-id>`)
- **Task worktrees**: Tasks run in worktrees (`feat-<name>-<feature-id>-<task-id>`) branching from feature branch
- **Squash merge**: Task worktrees squash-merge back into feature branch on completion
- **Merge train**: Feature branches serialize integration into `main` through merge queue
- **IPC**: Workers communicate via NDJSON over stdio (transport swappable)

### State Model

- **Work control**: Track task/feature progression through execution phases; end at `work_complete`
- **Collaboration control**: Track branch/merge/conflict coordination separately
- **Run state**: Transient execution details (retry/backoff, help/approval waits) live on `agent_runs` rows, not task enums

### Scheduling

- DAG-based with critical path optimization
- Milestone steering order work buckets, not dependencies
- Reservation overlap adds scheduling penalties
- Runtime overlap triggers coordination (same-feature suspend/resume, cross-feature pause/rebase)

## Documentation

Use docs landing pages, not one root file as full catalog:

- **ARCHITECTURE.md** - High-level overview and component map
- **docs/README.md** - Main docs landing page
- **docs/architecture/README.md** - Canonical architecture topics
- **docs/operations/README.md** - Verification, recovery, conflict coordination, warnings
- **docs/reference/README.md** - TUI, knowledge files, and codebase pointers
- **docs/architecture/worker-model.md** - Process-per-task execution, IPC, and crash recovery
- **docs/operations/testing.md** - Testing strategy
- **specs/README.md** - Grouped scenario-spec inventory

Deferred-note directories:
- `docs/concerns/` - Risks to watch
- `docs/optimization-candidates/` - Deferred performance ideas
- `docs/feature-candidates/` - Deferred product features
- `docs/compare/` - External comparisons and notes

## Testing

Tests use Vitest. Split across `test/unit/**/*.test.ts`, `test/unit/**/*.spec.ts`, `test/integration/**/*.test.ts`, and `test/integration/**/*.spec.ts`.

### Unit Tests
Executable unit tests live under `test/unit/`. Cover pure logic or narrow contract surfaces. No LLM calls or child processes. Key targets:
- DAG mutations and cycle detection
- Critical path calculation
- Scheduler ordering and frontier computation
- IPC message framing
- Graph invariant validation

### Integration Tests
Executable integration tests live under `test/integration/`. Use pi-sdk's `fauxModel` with scripted `FauxResponse` sequences to run real `Agent` loops with deterministic responses (no API calls). Harness scaffolds live under `test/integration/harness/`, shared deterministic fixtures live under `test/helpers/`. Test targets:
- Worker submit/confirm flow
- Feature branch lifecycle
- Merge train integration
- Conflict resolution (same-feature and cross-feature)
- Crash recovery
- Warning signals

### Scenario Specs
High-level test scenarios live in `specs/test_*.md` as markdown specs before conversion to executable tests.

## Configuration

- **TypeScript**: Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- **Module system**: ES modules with NodeNext resolution
- **Node version**: >=24
- **Linting**: Biome for formatting/linting, ESLint for extra checks
- **Path resolution**: Vitest configured with `tsconfigPaths: true`

## Commit Workflow

- **Use conventional commits**: Use conventional commit format (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, etc.)
- **Commit after each work item**: Make incremental commits after each discrete work item
- **Fix often**: Before running verify, run `npm run check:fix` to apply formatting and autofixable Biome changes
- **Verify before committing**: Always run `npm run check` and ensure it passes before commit

## Development Notes

- Read `ARCHITECTURE.md` first for big picture
- Start with `docs/README.md`, then relevant section README or topic page for subsystem details
- Follow existing TS path alias patterns when adding new modules
- Keep architectural boundaries clean (core should not depend on runtime/persistence/tui)
- Use faux provider pattern for integration tests
- Document architectural decisions in `docs/` rather than inline comments