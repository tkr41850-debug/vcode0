# Phase 1 — Safety & survivability

## Goal

Harden the worker IPC and retry paths so a single misbehaving worker (malformed output, hang, transient API failure, attempt at a destructive git op) cannot take down the orchestrator or silently lose work. Add durable persistence for escalations.

## Background

Verified gaps on `main`:

- `src/runtime/ipc/index.ts:35-41` catches `JSON.parse` errors but performs no shape validation; a structurally-malformed-but-JSON-valid frame becomes a downstream `TypeError`.
- `src/runtime/harness/index.ts` has only `ABORT_GRACE_MS=5000` post-abort SIGKILL. No periodic heartbeat — a hung worker holds its slot until orchestrator restart.
- `src/orchestrator/scheduler/events.ts:113-116` retries with a flat 1s delay, `max_retries=3`. No backoff, no jitter, no transient/semantic error split.
- `request_approval` tool exists but is voluntary; no `beforeToolCall` interception of `git push --force` / `git branch -D` / `git reset --hard`.
- No `inbox_items` or `ipc_quarantine` tables. Synchronous `request_approval`/`request_help` are the only escalation paths.

## Steps

Ships as **7 commits**, one per step, each green-on-commit.

---

### Step 1.1 — IPC frame shape validation

**What:** add TypeBox schemas for every variant of `WorkerToOrchestratorMessage` and `OrchestratorToWorkerMessage`, and validate every line in `NdjsonStdioTransport.onMessage` after `JSON.parse`. Invalid frames are dropped with a stderr log (a durable quarantine sink lands in step 1.3).

**Files:**

- `src/runtime/ipc/frame-schema.ts` — new. TypeBox `Type.Union` of `Type.Object` per frame variant. Export `validateWorkerFrame(value): { ok: true; frame } | { ok: false; error }` and `validateOrchestratorFrame(value)` for the worker-side direction. (`@sinclair/typebox` is already in `dependencies` — no install step.)
- `src/runtime/ipc/index.ts` — both `NdjsonStdioTransport` (orchestrator side, `:35-41`) **and** `ChildNdjsonStdioTransport` (worker side, `:71-73`) currently do bare `JSON.parse` then stderr write on error. Validate after parse in both classes; on failure, log `[ipc] invalid frame shape: <error>` and continue. Step 1.3 replaces the orchestrator-side stderr log with the quarantine ring; the worker-side stderr write stays (worker has no quarantine sink, and its stderr is read by the harness anyway).
- `src/runtime/contracts.ts` — keep TS types as the canonical surface; the schema mirrors them (manual sync for now).

**Tests:** `test/unit/runtime/ipc-frame-schema.test.ts` — round-trip every frame variant; assert that missing required fields, wrong types, and unknown `type` discriminators all return `ok: false` with a useful error path.

**Verification:**

```sh
npm run check:fix && npm run check
```

**Review subagent:**

> Review the changes on `main` since the last commit. Verify: (1) every variant of `WorkerToOrchestratorMessage` and `OrchestratorToWorkerMessage` declared in `src/runtime/contracts.ts` has a matching TypeBox schema branch in `frame-schema.ts`; (2) `NdjsonStdioTransport.onMessage` validates after parse and never throws on malformed input; (3) tests exercise both happy and shape-failure paths. Report any missed variant or unguarded path with file:line. Under 300 words.

**Commit:** `feat(runtime/ipc): typebox shape validation on worker frames`

---

### Step 1.2 — `ipc_quarantine` table + Store API

**What:** durable sink for malformed frames so post-crash debugging has a tail. Step 1.3 wires the in-process ring into this table.

**Files:**

- `src/persistence/migrations/011_ipc_quarantine.ts` — new TS migration creating `ipc_quarantine(id, ts, direction, agent_run_id, raw, error_message)` with `CREATE INDEX idx_ipc_quarantine_ts ON ipc_quarantine(ts DESC)` and partial index on `agent_run_id WHERE agent_run_id IS NOT NULL`. **Numbering**: Phase 5 step 5.2 ships migration `010_inbox_items.ts` first (Phase 5 is foundational and ships before Phase 1 per ship order 5→1→2→3→4); this is `011`.
- `src/persistence/db.ts` — register the new migration in the imports + `migrations` array literal (where `Migration001Init` … `Migration009AgentRunHarnessMetadata` and the new `Migration010InboxItems` from Phase 5 are wired). `src/persistence/migrations/index.ts` is the `MigrationRunner` class, not a registry — do not edit it.
- `src/orchestrator/ports/index.ts` — extend `Store` with `appendQuarantinedFrame(entry: QuarantinedFrameEntry): void` and `listQuarantinedFrames(opts?): QuarantinedFrameEntry[]`. Define `QuarantinedFrameEntry`.
- `src/persistence/sqlite-store.ts` — implement both. `appendQuarantinedFrame` is fire-and-forget (no `await` at call sites).

**Tests:** `test/unit/persistence/sqlite-store.test.ts` — extend with append + list round-trip; check ordering by `ts DESC` and partial-index filter.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the new `ipc_quarantine` migration: (1) idempotent (`CREATE TABLE IF NOT EXISTS`, no destructive `DROP`); (2) follows the pattern of existing migrations (`001_init.ts` … `009_*.ts`); (3) Store port additions are type-safe and the SqliteStore impl uses prepared statements; (4) no consumer wired yet. Flag any FK constraint omission, missing index, or interface drift. Under 300 words.

**Commit:** `feat(persistence): add ipc_quarantine table and Store API`

---

### Step 1.3 — Quarantine ring buffer + IPC integration

**What:** in-process bounded ring (default 64 entries) that holds the most recent malformed frames for inspection, plus a fire-and-forget write to `ipc_quarantine`. Wire `NdjsonStdioTransport` to call into the ring instead of the bare stderr log added in step 1.1.

**Files:**

- `src/runtime/ipc/quarantine.ts` — new. `class Quarantine` with `record(entry)`, `recent()`, `clear()`. Constructor takes capacity + an optional async sink (`(entry) => void`).
- `src/runtime/ipc/index.ts` — accept a `Quarantine` instance (optional); if present, replace stderr log with `quarantine.record({...})`.
- `src/compose.ts` — instantiate one `Quarantine` and pass `(entry) => store.appendQuarantinedFrame(entry)` as its sink. Thread it into the harness factory.
- `src/runtime/harness/index.ts` — accept `Quarantine` in `HarnessConfig`, pass to transport.

**Tests:**

- `test/unit/runtime/quarantine.test.ts` — ring eviction at capacity, `recent()` returns newest-first, sink invoked exactly once per entry.
- Extend `test/unit/runtime/ipc-frame-schema.test.ts` — assert that an invalid frame produces a `Quarantine.record` call.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the quarantine wiring: (1) ring buffer eviction is correct at exactly capacity; (2) sink failure (e.g. `appendQuarantinedFrame` throws) does not throw out of `record` — fire-and-forget semantics preserved; (3) `compose.ts` only constructs one `Quarantine` instance per orchestrator (not per worker); (4) the ring is reachable from the TUI/debug surface, or note that no consumer is wired yet. Under 300 words.

**Commit:** `feat(runtime/ipc): quarantine ring buffer with durable sink`

---

### Step 1.4 — Worker heartbeat + health timeout

**What:** orchestrator-side `health_ping` every `healthTimeoutMs / 2`; worker echoes `health_pong`. If no pong within the full window, harness synthesizes a terminal `error` frame (`kind: 'health_timeout'`) and SIGKILLs the child.

**Files:**

- `src/runtime/contracts.ts` — add `health_ping` and `health_pong` to the IPC frame unions.
- `src/runtime/ipc/frame-schema.ts` — add corresponding schema branches.
- `src/runtime/harness/index.ts` — add `HarnessHealthConfig.workerHealthTimeoutMs` (default 60_000). **Important:** `PiSdkHarness` is instantiated **once** by `compose.ts:237` (`new PiSdkHarness(sessionStore, projectRoot)`) and serves many child processes; per-session state must not live as instance fields on `PiSdkHarness`. Add the heartbeat state (`lastPong`, `intervalHandle`) **per `SessionHandle`** (one `setInterval` per child). Start the interval after fork (around `:163` where `child.pid` becomes available); track `lastPong`; on miss, synthesize the error frame, call `process.kill(pid, 'SIGKILL')`, clear the interval. Wire `clearInterval(handle)` into every termination path: the `child.on('exit'/'error')` handler at `:247-252`, and the `abort()` path at `:264`.
- `src/runtime/worker/index.ts` — handle inbound `health_ping` by replying `health_pong` immediately (do not block on the agent loop). **Pre-implementation check**: verify the worker's IPC handler runs on a microtask separate from the agent loop; if all inbound messages currently funnel through a single `await`-blocked queue, factor the pong handler out so it cannot be starved by a busy agent. Without this, the heartbeat reduces to "is the agent loop running?" rather than "is the worker process alive?".
- `src/config.ts` — add `workerHealthTimeoutMs` config field. Default `60000`. (Config is one file; there is no `src/config/` directory.)
- `src/compose.ts` — read config, pass into the harness factory at the existing harness-construction site (`:237`).

**Tests:**

- `test/integration/harness-heartbeat.test.ts` — faux worker that drops pongs after N rounds; assert harness emits `health_timeout` error and the run transitions to `retry_await` via the existing error handler.
- Unit test for the ping/pong round-trip with a fake transport.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the heartbeat: (1) interval is cleared on every termination path (normal exit, abort, timeout, error); (2) worker handler replies promptly even if the agent loop is busy (handler is registered before agent loop starts, runs on the IPC microtask, not a tool callback); (3) the synthesized `error` frame matches the existing error contract so the scheduler retry handler picks it up; (4) `workerHealthTimeoutMs` config is threaded end-to-end. Flag any leak (uncleared interval) or path that bypasses the timeout. Under 350 words.

**Commit:** `feat(runtime/harness): heartbeat with health timeout`

---

### Step 1.5 — Retry policy module + integration

**What:** replace the inline `retryAt: Date.now() + 1000` in `events.ts` with a `decideRetry(error, attempt, config)` function returning `{ kind: 'retry'; delayMs } | { kind: 'escalate_inbox'; reason }`. Transient classifications (network errors, 429, 5xx, `health_timeout`) get exponential backoff with jitter; semantic failures escalate immediately.

**Files:**

- `src/runtime/retry-policy.ts` — new. Export `RetryPolicy` interface as a sub-object with fields `{ transientPatterns: (RegExp | string)[]; baseDelayMs: number; maxDelayMs: number; jitterFraction: number; retryCap: number }`, plus `decideRetry(error, attempt, policy)` and `computeRetryBackoffMs(attempt, policy)`. Function is pure — caller injects `now` and `random` (or seeded RNG for tests). **Vocabulary boundary**: distinct from Phase 5's `maxSquashRetries` (deterministic git-conflict loop, no jitter/backoff). Siblings, not consumer/provider — do not collapse.
- `src/config.ts` — add `retryPolicy` config block as a single sub-object (not flat fields), so the structure mirrors the `RetryPolicy` interface above.
- `src/orchestrator/scheduler/events.ts` — call `decideRetry` at every error-path retry-decision site: the **`worker_message` error branch** (`message.type === 'error'`, around `:108-122`) and the **`feature_phase_error` handler** (around `:439-456`). Discriminate by event-type string, not handler alias — no `taskFailed`/`featurePhaseFailed` symbols exist in code. The rule is structural: every retry-decision site ("wait N ms then retry" or "give up") must go through `decideRetry`. On `escalate_inbox`, append to inbox (step 1.6 wires this; until then, pass-through to `failed` with a TODO). Do NOT touch Phase 5's squash-retry loop.
- `src/orchestrator/scheduler/index.ts:237-247` — events.ts handlers receive a `params` bag from this construction site, **not** a `deps` field. Add `retryPolicy` to that bag (or to `OrchestratorPorts` if it makes more sense as a long-lived dependency); thread through `compose.ts` from the new `retryPolicy` config block. `worker-pool.ts` does not own this code path; the events handler is invoked by the scheduler tick, not by the pool.

**Tests:**

- `test/unit/runtime/retry-policy.test.ts` — every classification + backoff math (deterministic by seeded RNG or jitter=0).
- Update `test/unit/orchestrator/recovery.test.ts` and any retry-touching scheduler test to use the new policy.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify retry policy: (1) `decideRetry` is pure (no I/O, no clock) — caller injects `now`; (2) jitter is bounded and never produces negative delay; (3) `retryCap` honored — once exceeded, returns `escalate_inbox` not `retry`; (4) every error-path retry-decision site in `src/orchestrator/scheduler/events.ts` — the `worker_message` error branch (`message.type === 'error'`) and the `feature_phase_error` handler, plus any new sites added by Phase 5's reorder — goes through `decideRetry`. Grep `events.ts` for `retryAt:` / `retryAt =` and confirm every hit is inside a `decideRetry`-fed branch. Do **not** assume handler aliases like `taskFailed`/`featurePhaseFailed` — those names do not exist in code; discriminate by the event-type string. (5) integration with `health_timeout` from step 1.4 is wired (transient classification); (6) Phase 5's squash-retry loop is left alone — it is a sibling git-conflict retry, not a `decideRetry` consumer. Flag any worker-error call site that still hard-codes a delay. Under 350 words.

**Commit:** `feat(runtime): retry policy module with backoff and inbox escalation`

---

### Step 1.6 — Inbox `kind` extensions + retry-policy integration

**Prerequisite:** Phase 5 step 5.2 must have landed (provides `inbox_items` table + `appendInboxItem`/`listInboxItems`/`resolveInboxItem` on `Store`). Phase 5 ships first per order 5→1→2→3→4.

**What:** the `inbox_items` table, Store methods, and the initial `kind` union (`'squash_retry_exhausted'`) are owned by Phase 5 step 5.2. This step extends the `kind` union with `'semantic_failure' | 'retry_exhausted'` and wires Step 1.5's `escalate_inbox` outcomes to write rows.

**Files:**

- `src/orchestrator/ports/index.ts` — extend the `InboxItemAppend` `kind` union to add `'semantic_failure'` and `'retry_exhausted'`. The Store method signatures already exist from Phase 5 step 5.2; no method additions needed.
- `src/orchestrator/scheduler/events.ts` — replace the TODO from step 1.5 with `store.appendInboxItem({ kind: 'semantic_failure' | 'retry_exhausted', ... })` at the `escalate_inbox` call sites in the `worker_message` error branch and the `feature_phase_error` handler.

**Tests:**

- Extend `test/unit/persistence/sqlite-store.test.ts` (already covers append/list/resolve from Phase 5 step 5.2) — assert the new `kind` values round-trip.
- `test/integration/retry-inbox-escalation.test.ts` — faux worker emits an error classified as semantic; assert an `inbox_items` row appears with the right `kind` and `payload`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify inbox kind extensions: (1) the `kind` union is the canonical TS string-literal union, not free-form; (2) the retry-policy integration in `events.ts` writes to inbox on every escalation path covered by this step — `'semantic_failure'` (semantic worker error) and `'retry_exhausted'` (retry-cap hit). `request_help` operator escalations are out of scope for Step 1.6 — they are a planner-side IPC frame, not a scheduler retry outcome, and are wired separately. Grep for any escalation in `events.ts` that still sets `runStatus = 'failed'` without an inbox row; (3) no consumer assumed to exist (this is a producer-only step); (4) the `inbox_items` table and Store methods from Phase 5 step 5.2 are not duplicated. Under 350 words.

**Commit:** `feat(scheduler): wire retry escalation to inbox_items`

---

### Step 1.7 — Destructive-op `beforeToolCall` guard

**What:** intercept `run_command` invocations at the pi-sdk `beforeToolCall` hook level. If the command matches `git push --force`, `git push -f`, `git branch -D`, or `git reset --hard`, block the call and append an `inbox_items` row with `kind: 'destructive_action'` for operator approval. The agent receives a tool error explaining the block.

**Files:**

- `src/agents/worker/destructive-ops.ts` — new. Export `isDestructiveCommand(cmd: string): { match: true; pattern: string } | { match: false }`. Pure regex test, with a small array of patterns. **Anchoring is critical**: `--force-with-lease` must NOT match the `--force` pattern. Suggested patterns:
  - `\bgit\s+push\s+(?:-f\b|--force(?!-with-lease)\b)` — matches `git push -f`, `git push --force`, but not `--force-with-lease`.
  - `\bgit\s+branch\s+-D\b` — capital D only (lowercase `-d` is a safe delete of merged branches).
  - `\bgit\s+reset\s+--hard\b` — any args after.
  Test the regex against every example listed in the Tests section before commit; one missed case here means an irreversible op slips through.
- `src/runtime/worker/index.ts` — register `beforeToolCall: async (toolName, input) => { ... }` on the pi-sdk Agent. For `run_command`, run the guard. On match, post a `request_approval` IPC frame (existing surface) and return `{ block: true, reason: 'destructive op requires approval: <pattern>' }`. The pi-sdk shape is `BeforeToolCallResult { block?: boolean; reason?: string }` (both optional, async hook). **MVP path**: block immediately and return `{ block: true, reason }`; inbox row carries the approval ask; agent retry is operator-initiated. Synchronous-await alternative deferred.
- `src/orchestrator/scheduler/events.ts` — when handling `request_approval` with `kind: 'destructive_action'`, call `store.appendInboxItem` with the same kind.

**Tests:**

- `test/unit/agents/worker/destructive-ops.test.ts` — match + non-match cases. Include `git push --force-with-lease` (must NOT match — that one is safe), `git push --force origin main` (must match), `git reset --hard HEAD~1` (must match), `git branch -d feature/x` (lowercase d — must NOT match).
- `test/integration/destructive-op-blocked.test.ts` — faux worker scripted to call `run_command` with a destructive shell command; assert (a) the tool returns the block message, (b) an `inbox_items` row is created.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify destructive guard: (1) regex set covers exactly `git push --force`, `git push -f`, `git branch -D`, `git reset --hard` — no broader patterns that produce false positives (especially `--force-with-lease`); (2) the pi-sdk hook returns `{ block: true }` rather than throwing — throwing would surface as a worker crash, not a tool error; (3) the `inbox_items` row carries enough payload to act on (command text, cwd, agentRunId); (4) the agent's transcript shows the block message so the LLM can adapt next turn. Under 400 words.

**Commit:** `feat(agents/worker): destructive-op guard via beforeToolCall`

---

## Phase exit criteria

- All seven commits land in order on a feature branch.
- `npm run verify` passes on the final commit.
- A faux-worker integration test (`test/integration/phase-1-survivability.test.ts`, optional) drives a worker through: malformed frame → quarantine; hang → heartbeat timeout → retry; transient error → backoff retry; destructive op → inbox row. Sanity check; can land as a Phase 1.8 commit.
- Run a final review subagent across all seven commits to confirm coherent survivability: no silently dropped escalation, no contradictions across layers on the same failure class, every durable table has a reader. Address findings before declaring the phase complete.
