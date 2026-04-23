# Stack Research

**Domain:** Local single-user autonomous coding orchestrator on pi-sdk (TypeScript, Node >=24)
**Researched:** 2026-04-23
**Confidence:** HIGH (for in-tree choices — versions pulled from `/home/alpine/vcode0/package.json`) / MEDIUM (for forward recommendations)

> Note on method: the full gsd-project-researcher agent run exceeded the upstream streaming timeout on every attempt (parallel and sequential). This report is compiled from the committed `package.json`, `ARCHITECTURE.md`, `docs/architecture/*`, and targeted reasoning about the current ecosystem. Library versions listed are **what the repo declares today**, and should be re-verified before any upgrade decision.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | ^5.9.3 | Source language | Strict mode with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` is the right baseline for a contract-heavy orchestrator; catches FSM-state mis-uses at compile time. NodeNext module resolution + ES modules throughout. |
| Node.js | >=24 | Runtime | Required by `engines` in `package.json`. Native ESM is mature; `node:*` import prefix; `--enable-source-maps` for debuggable stack traces. |
| `@mariozechner/pi-agent-core` (pi-sdk) | ^0.66.1 | Agent runtime | Locked-in. Provides the `Agent` class run loop (tools, messages, model routing, usage accounting), the `fauxModel` pattern used by integration tests, and the tool-call surface that drives the inbox (`await_response`, `request_help`). Child-process-per-task is the intended usage shape. **Spike target**: validate resume / replay fidelity when a worker is released and respawned (REQ-INBOX-03). |
| `@mariozechner/pi-tui` | ^0.66.1 | Terminal UI | Already in-tree; matches the user's memory ("pi-tui-aligned, event-driven usability"). Keep. |
| `better-sqlite3` | ^12.8.0 | State store | Synchronous API is a feature for this architecture — matches the single serial event queue. No promise overhead on the hot path. WAL mode is standard. |
| `simple-git` | ^3.35.2 | Git driver | Thin wrapper over `git` subprocess; worktree commands (`worktree add/remove/prune/list`) and rebase operations are available. Alternatives (`isomorphic-git`, `nodegit`) don't justify the switch given our native-git worktree reliance. |
| `@sinclair/typebox` | ^0.34.49 | Runtime schemas | Already in-tree; used for TypeScript-aware runtime validation (IPC envelope, config, agent tool schemas). Keep. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsx` | ^4.21.0 | Dev runner | `npm run tui` entrypoint; direct TS execution without build step. Source-checkout v1 leans on this. |
| `vitest` | ^4.1.4 | Test runner | `tsconfigPaths: true` for path aliases; unit + integration split works well. Node >=24 ESM supported. |
| `vite` | ^8.0.8 | Bundler (indirect) | Transitive dep of vitest. Not used for bundling app code (source-only v1). |
| `@microsoft/tui-test` | ^0.0.4 | TUI e2e testing | Wired for `test:tui:e2e`. Version `0.0.4` is pre-1.0 — treat API as unstable. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `@biomejs/biome` ^2.4.10 | Format + lint | Primary formatter/linter. Fast, single-binary, replaces most of what ESLint did. |
| `eslint` ^10.2.0 + `typescript-eslint` ^8.58.1 | Additional lint checks | `lint:ci` catches things Biome doesn't (e.g., type-aware rules). Kept until Biome type-aware lint lands. |
| `typescript` ^5.9.3 | Type checker | `tsc --noEmit` via `npm run typecheck`; run in CI / `npm run check`. |
| `npm` 11.6.3 | Package manager | Pinned via `packageManager` field. |

## Installation

```bash
# Already installed — see package.json. Source-checkout dev flow:
npm install
npm run check        # biome check + format + lint + typecheck + test
npm run tui          # dev entrypoint
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@mariozechner/pi-tui` | Ink (React-for-TUI) | If the TUI team wanted React mental model; pi-tui is the explicit direction per user memory, so Ink is rejected for v1. |
| `@mariozechner/pi-tui` | `blessed` / `blessed-contrib` | Legacy; powerful widgets but high friction for event-driven updates and modern TS. |
| `better-sqlite3` | `bun:sqlite` | Only if the whole runtime moved to Bun — not planned. |
| `better-sqlite3` | `libsql` / Turso | Adds remote-sync capability we don't need for a local single-user tool. |
| `simple-git` | `isomorphic-git` | Pure JS, but doesn't speak `git worktree` the way the real `git` CLI does. Worktrees are non-negotiable here. |
| `simple-git` | Direct `child_process.spawn('git', ...)` | Fine fallback if `simple-git`'s abstraction ever gets in the way; keeps us close to git. |
| NDJSON over stdio | MessagePack over stdio | MessagePack is smaller and faster to parse, but NDJSON is debuggable by eye and survives being mixed with stray stderr lines. Keep NDJSON for v1; revisit if throughput becomes a problem. |
| NDJSON over stdio | Unix domain sockets | More plumbing for minimal gain when we already have stdio pipes to the child. |
| Biome (alone) | Biome + ESLint (current) | Biome alone once its type-aware lint coverage matches `typescript-eslint`. Track `biome` releases; remove ESLint when parity lands. |
| `tsc` only build | `esbuild` bundle | If we ship a standalone distribution later (deferred — v1 is source-checkout only). |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `ts-node` | Slower, more finicky than `tsx` under Node >=24 ESM. | `tsx` |
| A separate ORM (Prisma / Drizzle) | Adds build-time schema dance, TypeScript generation overhead, and runtime client for a small local schema. `better-sqlite3` with typed wrapper queries is simpler. | Hand-written queries behind a thin `Store` port. |
| An event-emitter / pub-sub library | The architecture intentionally uses a single serial event queue — third-party EE pulls dev toward implicit fan-out. | Plain arrays + explicit dispatch in `orchestrator/`. |
| Parallel-safe IPC frameworks (gRPC, msgpack-rpc) | Overkill for parent↔child on the same machine. | NDJSON over stdio. |
| `jest` | Slower, worse ESM story than Vitest, redundant with repo's existing Vitest setup. | Keep Vitest. |
| `nodegit` | C++ build burden, incomplete worktree support. | `simple-git` + native `git`. |
| `process.env.*` sprinkled reads | Opaque config surface; conflicts with "config editable from TUI" (REQ-TUI-04). | One centralized `config.ts` module with typed schema + file watcher. |

## Stack Patterns by Variant

**If v1 ships as source-checkout only (current decision):**
- No bundling step. `tsx src/main.ts` via `npm run tui`.
- Dev dependencies at install time are fine.

**If v2 adds a standalone binary:**
- `esbuild --bundle --platform=node --format=esm` for a single-file build.
- Re-evaluate `@yao-pkg/pkg` vs Node.js SEA (Single Executable Applications) in the Node 24+ landscape.

**If usage tracking / budget enforcement is activated (REQ-CONFIG-02):**
- Pi-sdk provides per-agent-run `usage` accounting; persist to `agent_runs.usage_*` columns and aggregate via `replaceUsageRollups(patch)` as documented in `docs/architecture/graph-operations.md`.
- No additional library needed.

**If pi-sdk resume/replay fidelity is insufficient (spike outcome):**
- Fallback pattern: persist tool-call outputs to SQLite alongside the transcript so replay deterministically short-circuits previously-executed calls. This is a spike+design task, not a library swap.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@mariozechner/pi-agent-core@0.66.1` | `@mariozechner/pi-tui@0.66.1` | Matched minor. Upgrade both together — Mario's packages version in lockstep. |
| `better-sqlite3@12.8.0` | Node >=24 | `v12.x` supports Node 24. Rebuild when switching Node versions (native module). |
| `vitest@4.1.4` | `vite@8.0.8` | Matched. `tsconfigPaths: true` required for `@core/*` etc. aliases (see `vitest.config.ts`). |
| `tsx@4.21.0` | `typescript@5.9.3` + Node >=24 ESM | Works transparently; no `--loader` flag needed. |
| `@biomejs/biome@2.4.10` | `eslint@10.2.0` | Run Biome for format + fast lint, ESLint only for the `lint:ci` type-aware pass. Don't overlap rules. |
| `@microsoft/tui-test@0.0.4` | `@mariozechner/pi-tui@0.66.1` | Pre-1.0; treat as experimental. Keep scenarios minimal to minimize churn on updates. |

## Key Spike Targets (before committing to v1 plan)

1. **pi-sdk `Agent` resume/replay fidelity** (REQ-INBOX-03, REQ-STATE-02): does re-spawning a worker + replaying the transcript reach the same state as a live resumed process? What is the replay cost for a typical task (N tool calls)? Does `await_response` need any special handling on resume?
2. **pi-sdk `Agent` tool-call surface for `await_response` / `request_help`**: what is the exact tool schema? What does the agent expect back? How is a multi-task unblock on a single user answer expressed (REQ-INBOX-04)?
3. **`@mariozechner/pi-tui` suitability for the 4-surface TUI**: confirm event model supports background updates (worker transcripts streaming) while foreground has modal focus (inbox answer). Any escape-hatch renderers needed.
4. **`simple-git` worktree corner cases**: stale `.git/worktrees/<name>` after a crash; concurrent `rebase` on the same branch; `prune` behavior while a worktree has uncommitted changes.
5. **`@microsoft/tui-test`** pre-1.0 stability for e2e — how brittle is it? Is the budget "write e2e in v1" or "scripted smoke tests only"?

## Sources

- `/home/alpine/vcode0/package.json` — pinned versions (authoritative for current choices)
- `/home/alpine/vcode0/ARCHITECTURE.md` — design rationale for pi-sdk / SQLite / worktree choices
- `/home/alpine/vcode0/CLAUDE.md` — conventions (strict TS, ESM, Biome, Vitest)
- `/home/alpine/vcode0/docs/architecture/worker-model.md` — worker IPC / NDJSON rationale
- `/home/alpine/vcode0/docs/architecture/persistence.md` — SQLite schema and migrations
- `/home/alpine/vcode0/docs/architecture/budget-and-model-routing.md` — model selection + usage context
- General ecosystem knowledge (pre-2026 cutoff) — live verification required before upgrade decisions

---
*Stack research for: DAG-first autonomous coding orchestrator on pi-sdk*
*Researched: 2026-04-23*
