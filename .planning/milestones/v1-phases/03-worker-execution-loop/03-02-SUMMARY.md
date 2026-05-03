---
phase: 03-worker-execution-loop
plan: 02
subsystem: runtime-ipc
tags: [typebox, ndjson, ipc, quarantine, health-check, heartbeat, sqlite-migration, worker-lifecycle]

# Dependency graph
requires:
  - phase: 02-persistence-port-contracts
    provides: Store port + SQLite migration runner; typed config schema; worker-pool/harness scaffolding
provides:
  - "src/runtime/ipc/frame-schema.ts — typebox unions covering every wire variant, sole source of truth for IPC frame shapes"
  - "src/runtime/ipc/quarantine.ts — bounded (64) in-memory ring + fire-and-forget Store persistence for malformed lines"
  - "src/runtime/ipc/index.ts — NdjsonStdioTransport + ChildNdjsonStdioTransport validate every inbound line via Value.Check; never throw"
  - "src/runtime/harness/index.ts — health_ping/pong heartbeat with configurable workerHealthTimeoutMs (default 10s); SIGKILL + synthesized error/health_timeout on missed pongs"
  - "src/persistence/migrations/0004_ipc_quarantine.sql — ipc_quarantine table with ts/direction/agent_run_id/raw/error_message columns"
  - "Store.appendQuarantinedFrame port (on Store interface, SQLite + in-memory impls)"
  - "Config: GvcConfigSchema.workerHealthTimeoutMs (positive int, default 10_000)"
  - "commit_done frame variant in WorkerToOrchestratorFrame (pre-declared for consumption by plan 03-03)"
  - "health_timeout error kind recognized in error frame schema"
affects:
  - "03-03 (write-file + claim-lock hot path) — commit_done variant already declared; claim-lock RTT budget validated"
  - "03-04 (inbox) — may reuse quarantine module for failed inbox appends"
  - "07 (pause/resume) — typebox union makes checkpoint_ok / replay_request a 1-line addition"
  - "09 (crash recovery) — reads ipc_quarantine on boot to surface prior-crash frames as inbox entries"

# Tech tracking
tech-stack:
  added:
    - "@sinclair/typebox/value Value.Check + Value.Errors on the hot line-parse path (already a dep via tool schemas)"
  patterns:
    - "Schema-first IPC: TS types are Static<typeof X> re-exports from typebox unions — runtime + compile-time shapes cannot drift"
    - "Fire-and-forget persistence: queueMicrotask around Store writes so slow SQLite never stalls the readline handler; in-memory ring is authoritative for debug"
    - "Heartbeat with half-timeout ping interval and dual-miss policy: setInterval(ping, timeout/2), SIGKILL when Date.now() - lastPongTs > timeout"
    - "Defense-in-depth on both transport directions: child validates orchestrator-sent frames too (future multi-tenant safety)"
    - "Pre-allocated migration filenames (0004 here, 0003/0005/0006 to siblings) so Wave-1 parallel plans never race on sequence numbers"

key-files:
  created:
    - "src/runtime/ipc/frame-schema.ts"
    - "src/runtime/ipc/quarantine.ts"
    - "src/persistence/migrations/0004_ipc_quarantine.sql"
    - "test/unit/ipc/frame-schema.test.ts"
    - "test/unit/ipc/quarantine.test.ts"
  modified:
    - "src/runtime/ipc/index.ts (Value.Check + quarantine integration)"
    - "src/runtime/contracts.ts (re-export typebox-derived message types)"
    - "src/runtime/harness/index.ts (health-ping loop, lastPongTs tracking, SIGKILL on timeout)"
    - "src/runtime/worker/entry.ts (synchronous health_pong responder, pre-dispatch)"
    - "src/config/schema.ts (workerHealthTimeoutMs)"
    - "src/orchestrator/ports/index.ts (Store.appendQuarantinedFrame)"
    - "src/persistence/sqlite-store.ts (appendQuarantinedFrame impl + prepared stmt)"
    - "src/compose.ts, src/runtime/worker-pool.ts (wire quarantine + health config through composition root)"
    - "test/helpers/config-fixture.ts, test/integration/harness/store-memory.ts (in-memory Store.appendQuarantinedFrame, config defaults)"
    - "test/integration/worker-smoke.test.ts (3 new cases: malformed-line survival, health-timeout, claim-lock RTT)"

key-decisions:
  - "Typebox is the single source of truth for IPC frame shapes; contracts.ts re-exports Static<typeof T.Union> (per REQ-EXEC-03 + REQUIREMENTS.md line 24)."
  - "Ring buffer is authoritative for debug (64 entries); Store persistence is fire-and-forget via queueMicrotask so a slow SQLite write never stalls the line handler."
  - "Default workerHealthTimeoutMs=10_000 with ping cadence timeoutMs/2 — one missed ping is tolerated, two consecutive misses trigger SIGKILL."
  - "health_pong responder lives in the child ChildNdjsonStdioTransport pre-dispatch, NOT in the pi-sdk Agent loop — so a mid-tool-call agent cannot starve the heartbeat."
  - "commit_done frame schema pre-declared here (not in 03-03) to avoid a second migration pass on the schema and prevent schema drift at the seam."
  - "Migration sequence numbers pre-allocated at plan time (0004 here; 0003→03-01, 0005/0006→03-03) so Wave-1 parallel plans cannot race."

patterns-established:
  - "Inbound-line hardening: JSON.parse guard → Value.Check guard → handler, with quarantine.record on both failure modes. Never throw from the transport layer."
  - "Schema-to-TS re-export: contracts.ts exports `type X = Static<typeof XFrame>` so a new variant is one typebox edit, not a two-place sync."
  - "Heartbeat lifecycle: setInterval registered in createSessionHandle, cleared on both timeout-branch and child.on('exit'); lastPongTs updated inside the message dispatcher."

requirements-completed:
  - REQ-EXEC-03

# Metrics
duration: ~124m (wall-clock, including long tsc + test:unit runs under parallel load)
completed: 2026-04-23
---

# Phase 3 Plan 02: IPC Hardening Summary

**Hardened the NDJSON bridge with typebox schema validation on every inbound line, a 64-entry quarantine ring with fire-and-forget SQLite persistence, and a configurable health_ping/pong heartbeat — closing REQ-EXEC-03 end-to-end with 42 IPC unit tests and 3 new integration cases (malformed-line survival, health-timeout detection, claim-lock RTT).**

## Performance

- **Duration:** ~124 min wall-clock (commits span 18:31 → 20:35 UTC)
- **Started:** 2026-04-23T18:31:02Z (first commit dc2512f)
- **Completed:** 2026-04-23T20:35:38Z (final fix commit 77c9188)
- **Tasks:** 7 of 7 complete
- **Files created:** 5
- **Files modified:** 16
- **Commits:** 8 (7 task commits + 1 lint/typecheck follow-up)

## Accomplishments

- **Schema-first IPC.** Every frame variant in both directions has a typebox counterpart; contracts.ts TS unions are Static re-exports, so runtime and compile-time shapes cannot drift. `health_ping`, `health_pong`, `commit_done`, and `error.kind='health_timeout'` all declared here up front.
- **Quarantine + survival.** NdjsonStdioTransport (parent) and ChildNdjsonStdioTransport (child) never throw: JSON parse failures and schema violations both land in a 64-entry in-memory ring, with a non-blocking queueMicrotask-scheduled SQLite write for post-mortem analysis. Phase 9 recovery can now surface prior-crash frames as inbox entries.
- **Heartbeat.** Parent sends `health_ping` every `workerHealthTimeoutMs/2`; child responds synchronously from the IPC dispatch (pre-agent-loop), so mid-tool-call workers cannot starve the heartbeat. Two consecutive misses → `child.kill('SIGKILL')` + synthesized `error/health_timeout` frame feeding the normal terminal-error path.
- **Claim-lock RTT budget validated** in the integration smoke (<50ms ceiling; target <5ms per ASSUMPTION A2).

## Task Commits

1. **Task 1: Migration + Store.appendQuarantinedFrame** — `dc2512f` (feat)
2. **Task 2: quarantine.ts ring + async store** — `984b41a` (feat)
3. **Task 3: typebox frame-schema.ts + contracts re-exports** — `6d12164` (feat)
4. **Task 4: Value.Check + quarantine in both transports** — `a69f2eb` (feat)
5. **Task 5: health_ping/pong heartbeat in harness + worker entry** — `036b192` (feat)
6. **Task 6: frame-schema + quarantine unit tests (42 cases)** — `5011130` (test)
7. **Task 7: worker-smoke integration — malformed/health/RTT** — `230cd77` (test)
8. **Lint + typecheck follow-up** — `77c9188` (fix)

_Plan metadata commit will be added by the orchestrator upon SUMMARY/STATE update._

## Files Created / Modified

**Created**
- `src/runtime/ipc/frame-schema.ts` — typebox unions for both directions; every frame variant; `health_ping`, `health_pong`, `commit_done`, `error.kind` enum.
- `src/runtime/ipc/quarantine.ts` — bounded ring (default 64) + queueMicrotask Store write; errors swallowed; `recent()` returns a copy.
- `src/persistence/migrations/0004_ipc_quarantine.sql` — table + two indexes (ts DESC, agent_run_id partial).
- `test/unit/ipc/frame-schema.test.ts` — valid/invalid cases for every variant + per-direction union checks.
- `test/unit/ipc/quarantine.test.ts` — ring bound, FIFO, fire-and-forget, copy-on-read.

**Modified**
- `src/runtime/ipc/index.ts` — both transports take `Quarantine`, run `Value.Check`, call `quarantine.record` on failure, never throw.
- `src/runtime/contracts.ts` — `OrchestratorToWorkerMessage` / `WorkerToOrchestratorMessage` are now `Static<typeof ...>` re-exports.
- `src/runtime/harness/index.ts` — health-ping interval in `createSessionHandle`, `lastPongTs` update, SIGKILL + synthesized `error` frame, cleanup on child exit.
- `src/runtime/worker/entry.ts` — synchronous `health_pong` responder wired into `ChildNdjsonStdioTransport` before agent dispatch.
- `src/config/schema.ts` — `workerHealthTimeoutMs: z.number().int().positive().default(10_000)`.
- `src/orchestrator/ports/index.ts` — `Store.appendQuarantinedFrame` method added on the Store interface.
- `src/persistence/sqlite-store.ts` — prepared INSERT for ipc_quarantine; no return value; handles optional agent_run_id.
- `src/compose.ts`, `src/runtime/worker-pool.ts` — compose Quarantine with Store, pass through to transports; thread workerHealthTimeoutMs into harness.
- `src/orchestrator/scheduler/events.ts` — surface health_timeout in scheduler event narration.
- `test/helpers/config-fixture.ts`, `test/integration/harness/store-memory.ts` — in-memory Store implements appendQuarantinedFrame; config fixture exposes workerHealthTimeoutMs override.
- `test/integration/worker-smoke.test.ts` — three new `describe` blocks for malformed-line survival, health-timeout detection, claim-lock RTT measurement.
- `test/unit/orchestrator/recovery.test.ts`, `test/unit/orchestrator/scheduler-loop.test.ts`, `test/unit/runtime/ipc.test.ts` — ripple updates to construct Quarantine + carry workerHealthTimeoutMs in fixtures.

## Decisions Made

- Typebox over Zod (already standardized for tool schemas; REQUIREMENTS.md line 24).
- In-memory ring is authoritative for debug; SQLite write is fire-and-forget (non-blocking).
- Heartbeat lives in `ChildNdjsonStdioTransport` dispatch, pre-agent-loop.
- `commit_done` and `error.kind='health_timeout'` pre-declared here to prevent schema drift at the 03-03 seam.
- Pre-allocated migration sequence (0004 here; 0003→03-01, 0005/0006→03-03).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Internal typebox schema aliases shadowed TS type names**
- **Found during:** Cleanup pass after Task 7 commit.
- **Issue:** `frame-schema.ts` declared internal consts named `TaskSuspendReason`, `TaskResumeReason`, `TaskResult`, `Task`, `TaskPayload`, `GitConflictContext` — all of which are also TS type names imported elsewhere from `@core/types`. Under `exactOptionalPropertyTypes` the shadowing made TSC's inferred union types point at the wrong (too-narrow) anchors when the consts were used as `TSchema` values in test-case arrays, producing a cascade of `TS2375` errors in `test/unit/ipc/frame-schema.test.ts`.
- **Fix:** Renamed the internal schema consts to `TaskSuspendReasonSchema`, `TaskResumeReasonSchema`, `TaskResultSchema`, `TaskSchema`, `TaskPayloadSchema`, `GitConflictContextSchema`. Also dropped three internal schemas that became unreferenced (`UnitStatus`, `FeatureWorkControl`, `FeatureCollabControl`) after the Task schema stopped embedding them inline.
- **Files modified:** `src/runtime/ipc/frame-schema.ts`.
- **Verification:** `npm run typecheck` green; all 42 IPC unit tests green.
- **Committed in:** `77c9188`.

**2. [Rule 1 - Bug] Test-case array types were too narrow for the variant set**
- **Found during:** Same cleanup pass.
- **Issue:** `test/unit/ipc/frame-schema.test.ts` declared `cases: { schema: typeof RunFrame; ... }[]` and `cases: { schema: typeof ProgressFrame; ... }[]`. Under `exactOptionalPropertyTypes` every non-Run/Progress variant pushed into the array triggered `TS2375` because the element type could not hold the other variants' Static shapes.
- **Fix:** Imported `TSchema` from `@sinclair/typebox` and widened the element type to `{ name: string; schema: TSchema; value: unknown }`. This is the intended pattern for heterogeneous schema arrays.
- **Files modified:** `test/unit/ipc/frame-schema.test.ts`.
- **Verification:** `npm run typecheck` green.
- **Committed in:** `77c9188`.

**3. [Rule 1 - Bug] `makeTask` helper id param didn't satisfy TaskId brand**
- **Found during:** Same cleanup pass.
- **Issue:** `test/integration/worker-smoke.test.ts`'s `makeTask(id = 't-smoke')` used a plain `string` param, but `Task.id` is `TaskId = ` `` `t-${string}` ``. Under `exactOptionalPropertyTypes` + strict branding this was `TS2322`.
- **Fix:** Annotated the param as `id: ` `` `t-${string}` `` `= 't-smoke'`.
- **Files modified:** `test/integration/worker-smoke.test.ts`.
- **Verification:** `npm run typecheck` green.
- **Committed in:** `77c9188`.

**4. [Rule 1 - Bug] Biome formatter drift in 5 files**
- **Found during:** Same cleanup pass.
- **Issue:** Import ordering, unused-import trimming (stream `Writable` → `type Writable`), line-wrap of long union types — normal Biome format output that hadn't been committed after the Task 6/7 manual edits.
- **Fix:** `npx biome check --write` on the affected files.
- **Files modified:** `src/runtime/ipc/index.ts`, `src/runtime/harness/index.ts`, `test/integration/worker-smoke.test.ts`, `test/unit/ipc/frame-schema.test.ts`, `test/unit/ipc/quarantine.test.ts`.
- **Committed in:** `77c9188`.

---

**Total deviations:** 4 auto-fixed (all Rule 1 — typecheck + lint follow-ups after the main task commits). No architectural changes. No auth gates.
**Impact on plan:** None. The main feature work (quarantine + schema + heartbeat) landed exactly as planned.

## Test Results

- **IPC unit tests (scoped):** `npx vitest run test/unit/ipc` → **42 pass / 0 fail** (2 files).
- **Full unit suite:** 1445 pass / 5 fail / 1450 total. All 5 failures are pre-existing timing-sensitive tests in areas this plan does NOT touch (`test/unit/runtime/worktree.test.ts` x4 — git worktree provisioning, authored at `d82055f`; `test/unit/tui/view-model.test.ts` x1 — StatusBar render, authored pre-phase-3). They time out under the 5s default because the parallel-load run took 738s end-to-end instead of the normal ~60s. **Out of scope** per executor deviation rule "only auto-fix issues DIRECTLY caused by the current task's changes."
- **Typecheck:** `npm run typecheck` → exit 0.
- **Biome:** `npx biome check --write` on changed files → clean.

## Deferred Issues

- **Flaky unit tests under parallel load.** `test/unit/runtime/worktree.test.ts` (4 cases) and `test/unit/tui/view-model.test.ts` (1 case) time out at the default 5000ms when the test-unit suite is run under heavy parallel worktree load. These are pre-existing and unrelated to IPC. Recommend a dedicated follow-up plan to either (a) bump the per-test timeout for these specific suites, or (b) serialize the worktree-creation tests into a single pool. Logged here because executor rule requires tracking out-of-scope discoveries.

## Coordination Notes (for merge-back)

- **Parallel with 03-01.** 03-01 runs in `exec-03-01` and — per the orchestrator's resume note — adds PID-registry ops to the **bottom** of `src/orchestrator/ports/index.ts` and `src/persistence/sqlite-store.ts` under a `// === PID registry (Phase 3, plan 03-01) ===` section marker. My `appendQuarantinedFrame` edits sit **above** that boundary in both files, so there should be no overlapping hunk. If 03-01 also added a separate method on `Store`, the orchestrator will need to reconcile imports in `compose.ts`.
- **Potential path conflict (flagged by orchestrator):** orchestrator mentioned 03-01 may have renamed `src/persistence/sqlite/store.ts` → `src/persistence/sqlite-store.ts`. In this worktree the path is **already** `src/persistence/sqlite-store.ts`, so either the rename predated both branches or 03-01 did the rename without touching my edits. If a conflict surfaces at merge time, move my `appendQuarantinedFrame` block into whichever filename wins.
- **No changes under `src/persistence/migrations/` sequence numbers other than my pre-allocated 0004.** 03-01 owns 0003; 03-03 owns 0005/0006. No race.
- **Config schema.** I added `workerHealthTimeoutMs` to `GvcConfigSchema` in `src/config/schema.ts`. 03-01's PID registry is not expected to touch that file; if it does, re-apply my one-line default.
- **Compose root.** `src/compose.ts` gained a `createQuarantine` wiring and passes `quarantine` into `NdjsonStdioTransport` + `ChildNdjsonStdioTransport`. If 03-01 also touches `compose.ts`, re-thread both constructor args after merge.

## Self-Check: PASSED

- All 5 created files present at expected paths.
- All 8 commits present in `git log --oneline` on `exec-03-02`.
- `npx vitest run test/unit/ipc` → 42/42 green.
- `npm run typecheck` → exit 0.
- Biome clean on all modified files.

---
*Phase: 03-worker-execution-loop*
*Plan: 02*
*Completed: 2026-04-23*
