# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**gvc0** is a TypeScript remake of GSD-2 built on pi-sdk (`@mariozechner/pi-agent-core`). It implements a DAG-first autonomous agent orchestration system that maximizes parallelism at every level. The system organizes work around a feature DAG with task DAGs local to each feature branch, and handles collaboration with `main` through a serialized merge train.

Core thesis: The DAG is the only execution model. Features depend only on features. Tasks depend only on tasks within the same feature. Work progression is tracked through work control phases, while branch/merge/conflict coordination is tracked separately through collaboration control states.

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

This is a single root TypeScript package (not a monorepo) with architectural boundaries under `src/` using TS path aliases:

- `@app/*` - Application lifecycle and startup
- `@core/*` - Pure domain logic (graph/state types, scheduling rules, warnings)
- `@orchestrator/*` - Service layer (scheduler, feature lifecycle, conflicts, summaries)
- `@agents/*` - Planner and replanner agents with prompts and tools
- `@runtime/*` - Worker pool, IPC, harness, context assembly
- `@persistence/*` - SQLite implementation with better-sqlite3
- `@tui/*` - Terminal UI components and view models

### Execution Model

- **Process-per-task**: Each task spawns a dedicated child process running a pi-sdk `Agent` in an isolated git worktree
- **Feature branches**: Each feature owns one long-lived integration branch (`feat-<feature-id>`)
- **Task worktrees**: Tasks run in worktrees (`feat-<feature-id>-task-<task-id>`) that branch from the feature branch
- **Squash merge**: Task worktrees squash-merge back into the feature branch on completion
- **Merge train**: Feature branches serialize integration into `main` through a merge queue
- **IPC**: Workers communicate via NDJSON over stdio (swappable transport)

### State Model

- **Work control**: Tracks task/feature progression through execution phases (ends at `work_complete`)
- **Collaboration control**: Tracks branch/merge/conflict coordination separately
- **Run state**: Transient execution details (retry/backoff, help/approval waits) live on `agent_runs` rows, not task enums

### Scheduling

- DAG-based with critical path optimization
- Milestone steering provides ordered work buckets but doesn't create dependencies
- Reservation overlap applies scheduling penalties
- Runtime overlap triggers coordination (same-feature suspend/resume, cross-feature pause/rebase)

## Documentation

Use the docs landing pages rather than treating one root file as the full catalog:

- **ARCHITECTURE.md** - High-level overview and component map
- **docs/README.md** - Main documentation landing page
- **docs/architecture/README.md** - Canonical architecture topics
- **docs/operations/README.md** - Verification, recovery, conflict coordination, warnings
- **docs/reference/README.md** - TUI, knowledge files, and codebase pointers
- **docs/worker-model.md** - Process-per-task execution, IPC, and crash recovery
- **docs/testing.md** - Testing strategy
- **specs/README.md** - Grouped scenario-spec inventory

Deferred-note directories:
- `docs/concerns/` - Implementation risks to watch
- `docs/optimization-candidates/` - Deferred performance ideas
- `docs/feature-candidates/` - Deferred product features
- `docs/compare/` - External comparisons and notes

## Testing

Tests use Vitest and are split across `test/unit/**/*.test.ts`, `test/unit/**/*.spec.ts`, `test/integration/**/*.test.ts`, and `test/integration/**/*.spec.ts`.

### Unit Tests
Executable unit tests live under `test/unit/` and cover pure logic or narrow contract surfaces with no LLM calls or child processes. Key targets:
- DAG mutations and cycle detection
- Critical path calculation
- Scheduler ordering and frontier computation
- IPC message framing
- Graph invariant validation

### Integration Tests
Executable integration tests belong under `test/integration/`. Use pi-sdk's `fauxModel` with scripted `FauxResponse` sequences to run real `Agent` loops with deterministic responses (no API calls). Harness scaffolds live under `test/integration/harness/`, while shared deterministic fixtures live under `test/helpers/`. Test targets:
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
- **Linting**: Biome for formatting/linting, ESLint for additional checks
- **Path resolution**: Vitest configured with `tsconfigPaths: true`

## Commit Workflow

- **Use conventional commits**: Follow the conventional commit format (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, etc.)
- **Commit after each work item**: Make incremental commits as you complete discrete pieces of work
- **Format often**: Before running verify, run `npm run format` to fix formatting issues.
- **Verify before committing**: Always run `npm run check` and ensure it passes before creating a commit

## Development Notes

- Read `ARCHITECTURE.md` first for the big picture
- Start with `docs/README.md`, then consult the relevant section README or topic page for subsystem details
- Follow the existing TS path alias patterns when adding new modules
- Keep architectural boundaries clean (core should not depend on runtime/persistence/tui)
- Use the faux provider pattern for integration tests
- Document architectural decisions in `docs/` rather than inline comments
