# Phase 9 — First-failure error logs on retry

## Goal

When a task or feature-phase run hits its first error and the orchestrator transitions the run to `retry_await`, dump a single human-readable text file under `.gvc0/logs/` containing the failure message, stack trace, and surrounding run metadata. Subsequent retries of the same run do not re-dump. The feature is a debugging aid only; no scheduler, retry-policy, or persistence semantics change.

This phase is single-orchestrator, single-machine. A short adaptation section at the end describes the additional hook the distributed track (`02-distributed/phase-5-leases-and-recovery.md`) needs so the same artifact appears for lease-takeover failures.

## Scope

**In:** optional `stack` field on the worker `error` IPC frame; `RunErrorLogSink` port + filesystem implementation rooted at `<projectRoot>/.gvc0/logs/`; hook at the two retry-decision sites in `events.ts` (task error branch + `feature_phase_error`); `restartCount === 0` first-only gate inside the sink; `no-stack` sentinel for synthesized frames (`worker_exited`; `health_timeout` variant is cross-linked from Phase 1 step 1.4 and not delivered here).

**Out:** new `agent_runs` columns or side tables (file-only artifact); log rotation/retention/pruning (deferred); worker-side log files; multi-orchestrator log-directory contention; surfacing log path in TUI inbox rows; lease-takeover hook (informational adaptation note for `02-distributed`, no work here).

## Background

Verified gaps on `main`:

- Worker error frame (`src/runtime/contracts.ts:441-447`) carries `error: string` only — no stack. Worker `formatError` (`src/runtime/worker/index.ts:859-866`) returns `err.message` for `Error` instances and discards `err.stack`.
- Orchestrator-side error handler at `src/orchestrator/scheduler/events.ts:108-122` flips the run to `retry_await` and persists `retryAt`; `error` text is not written to `agent_runs` or any side table.
- The synthesized error from `src/runtime/worker-pool.ts:674-687` (bare child exit, no IPC frame) carries only `worker_exited: code=… signal=…` — no stack ever exists, even with the change above.
- `agent_runs` schema (`src/persistence/migrations/001_init.ts:61-76`) has no error/stack column. Worker `stderr` is inherited (`src/runtime/harness/index.ts:190-199`), not captured.
- `.gvc0/` currently contains `state.db`, `worktrees/` (created by `ensureRuntimeDirs` at `src/compose.ts:346`), and lazily-created `sessions/` (`src/runtime/sessions/index.ts:46-86`). No `.gvc0/logs/` directory exists, no log-path port exists.
- `restartCount` is bumped on next dispatch (`src/orchestrator/scheduler/dispatch.ts:188,223,514-517`), not on error receipt. At `events.ts:108` receipt time, the row's `restartCount === 0` reliably identifies the **first** failure for a run, regardless of whether the error came from the worker or was synthesized by the pool.

The hook site is the same place Phase 1 step 1.5 unifies retry decisions, so this phase is best ordered after Phase 1 ships.

## Design summary

- The worker keeps sending one IPC frame per error; the frame gains an optional `stack` field (`src/runtime/contracts.ts:441-447`). All consumers treat it as advisory metadata. No new frame variant.
- A new `RunErrorLogSink` port is added to `OrchestratorPorts`; the SQLite-side wiring is replaced by a filesystem-backed implementation that writes `.gvc0/logs/` files. `core/` remains free of `fs` imports.
- The events handler at `src/orchestrator/scheduler/events.ts:108-122` (task) and `:439-456` (feature-phase) calls `errorLogSink.writeFirstFailure(run, frame, now)` immediately before the existing `updateAgentRun` call. The sink is a no-op when `run.restartCount !== 0`.
- The sink is invoked inside the same path for both worker-emitted errors and `worker-pool.ts`-synthesized exit-frames. Frames that lack a stack get a "no-stack" variant body that names the synthesizer and includes whatever signal/exit-code information arrived.
- The sink performs path slugging, sanitization, directory creation (`mkdir -p` semantics on the orchestrator project root), and write. No fsync; debug log, not durable state.
- Retention is intentionally not implemented in this phase — see Notes.

## Steps

Ships as **3 commits**, in order.

---

### Step 9.1 — Carry stack through the worker error frame

**What:** extend the `error` IPC frame with optional `stack: string` and have the worker populate it from `Error.stack` when the run loop catches a thrown error.

**Files:**

- `src/runtime/contracts.ts` — add `stack?: string` to the `'error'` variant of `WorkerToOrchestratorMessage` (`:441-447`). Keep the field optional so older orchestrator builds tolerate worker frames missing it, and so the `worker-pool.ts` exit synthesizer (which has no stack) is type-correct without changes.
- `src/runtime/ipc/frame-schema.ts` — extend the matching TypeBox branch added in Phase 1 step 1.1 with `Type.Optional(Type.String())` for `stack`. If Phase 1 has not yet shipped, this becomes a no-op edit and ships in the same commit as Phase 1 step 1.1, or this phase is gated on Phase 1.
- `src/runtime/worker/index.ts` — replace `formatError` (`:859-866`) with a small helper returning `{ message: string; stack?: string }`. Update the single call site at `:177-184` to send both fields. `Error.stack` already includes the message at its head; do not strip — passing `err.stack` verbatim is the most useful artifact.
- `src/runtime/worker-pool.ts` — synthesizer at `:674-687` keeps producing frames with no `stack`. The orchestrator-side log writer interprets a missing `stack` as the "no-stack reason" variant.

**Tests:**

- `test/unit/runtime/ipc-frame-schema.test.ts` — extend the existing schema test to round-trip the `stack` field on `error`. Assert that an `error` frame missing `stack` still validates.
- `test/integration/worker-error-stack.test.ts` — new. Faux worker scripted to throw a synthetic `Error('boom')` mid-run; capture the `error` frame at the orchestrator IPC boundary; assert `frame.stack` starts with `Error: boom\n    at ` and contains the synthetic frame's filename. Use the existing fauxModel harness in `test/integration/harness/`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the stack-carrying frame change: (1) `WorkerToOrchestratorMessage 'error'` declares `stack` as optional, not required, and the schema mirrors the type exactly; (2) the worker-side helper returns the unchanged `Error.stack` rather than re-formatting it; (3) the worker-pool exit synthesizer at `src/runtime/worker-pool.ts:674-687` is unchanged and its frames still validate; (4) no new IPC frame variant was introduced — the change is field-additive on `'error'`. Flag any consumer that destructures the old single-string `error` field positionally. Under 300 words.

**Commit:** `feat(runtime/ipc): carry stack on worker error frame`

---

### Step 9.2 — `RunErrorLogSink` port + filesystem implementation

**What:** introduce a `RunErrorLogSink` port that writes one text file per first failure, plus a default implementation rooted at `<projectRoot>/.gvc0/logs/`. Wire it through `compose.ts` like other `OrchestratorPorts` members. No call sites yet — that lands in step 9.3.

**Files:**

- `src/orchestrator/ports/index.ts` — add `runErrorLogSink: RunErrorLogSink` to `OrchestratorPorts`. Define the port:
  ```ts
  export interface RunErrorLogSink {
    writeFirstFailure(input: {
      run: AgentRun;
      featureId: FeatureId | undefined;
      taskId: string | undefined;
      error: { message: string; stack?: string };
      synthesizedReason?: 'worker_exited' | 'health_timeout';
      nowMs: number;
    }): Promise<void>;
  }
  ```
  Definitions of `AgentRun` / `FeatureId` already live under `@core/types`.
- `src/runtime/error-log/index.ts` — new. Default implementation `FileSystemRunErrorLogSink`. Constructor takes `{ projectRoot: string; logDirName?: string }`. `logDirName` defaults to `'logs'`. The implementation:
  1. Builds a slug of the form `<iso-ts>-<scopeKind>-<featureSlug>-<phase>[-<taskSlug>]-a<restartCount>-<runIdShort>.txt`. ISO timestamp uses `nowMs`, with `:` and `.` replaced by `-` for filesystem safety. `featureSlug` and `taskSlug` come from the existing slug helpers used by worktree provisioning if they expose a public function; otherwise inline a small `[^A-Za-z0-9._-]+ → '-'` reducer with a 32-char cap. `runIdShort` is the first 8 chars of `run.id` to disambiguate clock collisions.
  2. `mkdir(path.join(projectRoot, '.gvc0', logDirName), { recursive: true })`.
  3. Composes the body (header + message + stack-or-reason). See body schema below.
  4. `writeFile(filePath, body, { encoding: 'utf8', flag: 'wx' })`. The `wx` flag fails loudly if the slug ever collides; the runId suffix should make collision essentially impossible. Errors are caught and logged once to `stderr` — sink failure must not propagate (see review prompt).
- `src/compose.ts` — instantiate `new FileSystemRunErrorLogSink({ projectRoot })` and pass it through the `OrchestratorPorts` construction. `projectRoot` is already available at `compose.ts:49` via the same path that builds `.gvc0/state.db`.
- `src/core/types/index.ts` — no changes. `RunErrorLogSink` lives in the orchestrator port surface only; `core/` is unaware.

**Body schema (plain text):**

```
gvc0 first-failure log
runId: <run.id>
scopeType: task|feature_phase
scopeId: <run.scopeId>
featureId: <featureId or "->">
phase: <run.phase>
taskId: <taskId or "->">
sessionId: <run.sessionId or "->">
restartCount: <run.restartCount>
maxRetries: <run.maxRetries>
retryAt: <run.retryAt or "->">
ts: <ISO timestamp from nowMs>
synthesizedReason: <reason or "->">

--- message ---
<error.message>

--- stack ---
<error.stack or "(no stack: this error was synthesized by the orchestrator from a child-process exit; no IPC error frame was received)">
```

The "no stack" sentinel applies when `error.stack` is absent. `synthesizedReason` ties the entry back to the `worker-pool.ts` synthesis path or the Phase 1.4 `health_timeout` synthesis.

**Tests:**

- `test/unit/runtime/error-log-sink.test.ts` — new.
  - Uses a `tmpProjectRoot` (`fs.mkdtemp`) as `projectRoot`.
  - `writeFirstFailure` produces a file under `<root>/.gvc0/logs/`.
  - File body matches the schema (snapshot or string assertions on each header field).
  - Slug sanitization: synthesize a feature with name `feat/my weird . name`, assert the slug contains no `/` or whitespace.
  - Two consecutive calls with different `runId` produce two distinct files; same `runId`+timestamp would collide but the test seeds different `nowMs` and asserts both writes succeed.
  - Sink failure mode: shadow the directory with a read-only mode (or stub `writeFile` to throw); assert the returned promise resolves without throwing and that one stderr line was emitted.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the new `RunErrorLogSink` port and its filesystem implementation: (1) the port lives on `OrchestratorPorts` and is constructed exactly once in `compose.ts`; (2) the filesystem implementation does not import any `core/` module other than the type re-exports it consumes; (3) the slug function strips path separators and whitespace and is stable for the same input; (4) sink failure does not throw out of `writeFirstFailure` — it logs and resolves, otherwise a missing log directory could crash the scheduler tick; (5) the body schema includes every field listed in the phase doc, with sentinels for absent values. Confirm that no consumer is wired yet — this step is producer-only, the events.ts hook lands in step 9.3. Under 350 words.

**Commit:** `feat(orchestrator): add RunErrorLogSink port and filesystem implementation`

---

### Step 9.3 — Hook the sink at the retry-decision sites in `events.ts`

**What:** call `runErrorLogSink.writeFirstFailure` in the two error-receipt branches of `src/orchestrator/scheduler/events.ts` immediately before the existing `updateAgentRun` calls. Gate by `run.restartCount === 0` inside the sink, not at the call site, to keep the call uniform and let the sink own the "first only" semantics.

**Files:**

- `src/orchestrator/scheduler/events.ts`:
  - Task error branch at `:108-122`. Construct the input from `message` and `run`. `featureId` comes from `message.scopeRef?.featureId` if present; fall back to `graph.tasks.get(run.scopeId)?.featureId` for safety. `taskId` is `run.scopeId`. `synthesizedReason` is `'worker_exited'` if `message.error.startsWith('worker_exited:')`, otherwise unset; `'health_timeout'` is added in step 1.4 of Phase 1's heartbeat (cross-link only — Phase 1 carries that variant).
  - Feature-phase error branch at `:439-456`. `featureId` is `event.featureId`. `taskId` is undefined. `synthesizedReason` is unset (feature-phase errors do not currently flow through the pool synthesizer).
- `src/runtime/error-log/index.ts` — `writeFirstFailure` returns early when `input.run.restartCount !== 0`. Keep the early return behind a debug log line that names the run id and the current restartCount so an operator inspecting stderr can confirm the gate fired.
- `src/orchestrator/scheduler/index.ts` — already passes `ports` into the events handler; no signature change needed because the sink is a member of `OrchestratorPorts`.

**Tests:**

- `test/unit/orchestrator/events-error-log.test.ts` — new.
  - Stub `RunErrorLogSink` with a recording fake. Drive a task `worker_message` of type `'error'` through `handleSchedulerEvent` for a run with `restartCount: 0`; assert one `writeFirstFailure` call with the right shape, then assert the existing `updateAgentRun(retry_await)` still ran.
  - Repeat with `restartCount: 1`; assert the sink received the call but the recorded fake observes `writeFirstFailure` was a no-op (assert via the sink's own restartCount-gated branch — covered by the unit test for the sink, not by this test).
  - Drive a `feature_phase_error` event; assert one sink call with `taskId: undefined`.
  - Drive a synthesized exit (`error: 'worker_exited: code=1 signal=null'`); assert `synthesizedReason: 'worker_exited'` and the sink body would render the no-stack sentinel.
- `test/integration/retry-error-log.test.ts` — new. Faux worker throws once, then the orchestrator retries and the second run completes. Assert exactly one `.gvc0/logs/*.txt` file exists in the test project root and its body contains the synthetic stack.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the retry-error-log hook: (1) both retry-decision sites in `src/orchestrator/scheduler/events.ts` (task error branch and `feature_phase_error` handler) call `runErrorLogSink.writeFirstFailure` before they call `updateAgentRun`; (2) sink failure is swallowed (the `await` either returns void or the sink catches internally) — a failed write must not prevent the run from transitioning to `retry_await`; (3) the first-failure gate lives in the sink, not at the call sites, so retry-policy changes from Phase 1.5 do not bypass it; (4) the synthesized-exit branch from `src/runtime/worker-pool.ts:674-687` flows through the same path and is recorded with `synthesizedReason: 'worker_exited'`; (5) no new field is persisted on `agent_runs` — the dump is file-only. Under 400 words.

**Commit:** `feat(scheduler): dump first-failure run error log on retry_await`

---

## Distributed adaptation

This subsection is informational for the distributed track; no work is performed in this phase.

In `02-distributed`, the same `RunErrorLogSink` port is reused, and `compose.ts` continues to instantiate the filesystem implementation against the orchestrator host's project root. The remote worker keeps sending the same IPC `error` frame variant, including the new `stack` field, over the network transport from `phase-1-protocol-and-registry.md`. No worker-side log files are written; remote workers do not own the orchestrator's `.gvc0/logs/` directory.

Two distributed-only seams need a follow-up step layered onto `02-distributed/phase-5-leases-and-recovery.md`:

1. **Lease takeover writes a no-stack entry.** When a lease expires (`heartbeat_timeout`, `worker_shutdown`, `local_child_exit_crash`, `forced_takeover` per the audit row at `02-distributed/phase-5-leases-and-recovery.md:318`), the lease-expiry handler synthesizes a terminal error similar to `worker-pool.ts:674-687`. That synthesizer must call `runErrorLogSink.writeFirstFailure` with `synthesizedReason: 'lease_takeover'` and a body fragment that names the lease event reason, the bumped fence value, and the audit-row id from `run_lease_events`. The "no stack" sentinel applies — the worker is unreachable, so its real stack is unobtainable.
2. **Bare-transport close stays silent.** Phase 2's `RemoteHarness` design (`02-distributed/phase-2-remote-task-execution.md:279,309`) deliberately does not fire `onExit` on bare transport close, so no error frame is generated for transient drops. The error log is only written when the lease layer eventually decides to take over (item 1) or when a real `error` frame arrives over the reattached network. This is the correct behavior — flapping connections must not produce flapping log files.

A small ordering note: the lease-takeover synthesizer must call the sink **before** updating `agent_runs.restart_count`, so the sink's `restartCount === 0` gate matches the local-machine semantics. The events.ts hook from step 9.3 already obeys this ordering; the lease handler should mirror it.

The follow-up step can be added as a new bullet under `02-distributed/phase-5-leases-and-recovery.md` step 5.5 ("Lease expiry, fence bump, reroute") or as its own step 5.6.5. No change to the port surface or the filesystem implementation is required for that work.

## Phase exit criteria

- All three commits land in order on a feature branch.
- `npm run verify` passes on the final commit.
- Driving the integration test from step 9.3 produces exactly one `.gvc0/logs/*.txt` file with the synthetic stack on first failure, and no additional file on the second-attempt retry.
- A manual smoke run against the existing faux-worker fixtures shows that a synthesized `worker_exited:` frame writes the no-stack variant.
- Run a final review subagent across all three commits to confirm: (a) `core/` did not gain an `fs` import, (b) the `restartCount === 0` gate is the single source of "first only" truth, (c) the doc-described body schema matches what the implementation writes, (d) sink failure does not propagate.

## Notes

- **Retention is deferred.** Phase 6 ships before Phase 9 in the recommended order, so it cannot include a pruner for a directory that does not yet exist. A follow-up config phase (or Phase 6 in a subsequent iteration) is the natural home for an age- or count-based pruner; this phase intentionally adds no rotation policy. The directory is debug-only and an operator can `rm -rf .gvc0/logs/` at any time without affecting orchestrator state.
- **No new persisted column.** The dump is file-only by design. Adding `agent_runs.error_text` or a side table would require a migration and would duplicate information that is more useful as a free-form text artifact. If the TUI later wants to surface "the log path for this failed run", a follow-up step can return the path from `writeFirstFailure` and store it on a future inbox row (table introduced by Phase 5 step 5.2; `kind` union extended by Phase 1 step 1.6) — out of scope here.
- **First failure, not first error per attempt.** The gate is `run.restartCount === 0` so the artifact captures the original failure even when the retry path itself fails. If an operator needs every retry's stack, they should rerun with the orchestrator's stderr captured — that path already shows every failed frame.
- **Bare child exit has no stack regardless of step 9.1.** The synthesizer at `src/runtime/worker-pool.ts:674-687` only sees the exit code and signal. The dump's "no stack" sentinel is the durable artifact in that case; do not chase the missing stack from a different layer.
- **Single-orchestrator assumption.** Multi-writer log directories are out of scope. The slug includes the timestamp and the run id suffix so concurrent writes from the single-process orchestrator never collide.
- **Recommended ship position:** after Phase 1 (so the retry-decision sites are already unified by step 1.5) and independently of Phases 2–7. Could also ship before Phase 1 against the current `events.ts` shape — the call sites would simply move once Phase 1 lands.
