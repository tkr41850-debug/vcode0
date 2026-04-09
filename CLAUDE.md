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

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

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
- `@git/*` - Feature branches, worktrees, merge train, overlap detection
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

The `docs/` directory contains comprehensive architecture documentation:

- **ARCHITECTURE.md** - High-level overview and documentation index
- **data-model.md** - Feature/task hierarchy, dependency constraints, state model
- **graph-operations.md** - DAG mutations, validation, scheduling, merge train
- **worker-model.md** - Process-per-task execution, IPC, crash recovery
- **persistence.md** - SQLite schema and state persistence
- **verification-and-recovery.md** - Retries, verification, stuck detection, replanning
- **testing.md** - Unit and integration testing strategy
- **conflict-steering.md** - Sync recommendations and conflict handling
- **file-lock-conflict-resolution.md** - Same-feature overlap detection and resolution
- **cross-feature-overlap-priority.md** - Cross-feature runtime overlap policy

Additional directories:
- `docs/concerns/` - Implementation risks to watch
- `docs/optimization-candidates/` - Deferred performance ideas
- `docs/feature-candidates/` - Deferred product features

## Testing

Tests use Vitest and are configured to run from `test/**/*.test.ts` and `test/**/*.spec.ts`.

### Unit Tests
Pure logic tests with no LLM calls or child processes. Key targets:
- DAG mutations and cycle detection
- Critical path calculation
- Scheduler ordering and frontier computation
- IPC message framing
- Graph invariant validation

### Integration Tests
Use pi-sdk's `fauxModel` with scripted `FauxResponse` sequences to run real `Agent` loops with deterministic responses (no API calls). Test targets:
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
- **Verify before committing**: Always run `npm run verify` and ensure it passes before creating a commit

## Development Notes

- Read `ARCHITECTURE.md` first for the big picture
- Consult relevant `docs/*.md` files for subsystem details
- Follow the existing TS path alias patterns when adding new modules
- Keep architectural boundaries clean (core should not depend on runtime/persistence/git/tui)
- Use the faux provider pattern for integration tests
- Document architectural decisions in `docs/` rather than inline comments
