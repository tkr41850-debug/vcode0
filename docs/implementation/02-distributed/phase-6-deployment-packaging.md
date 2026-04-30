# Phase 6 — Worker deployment packaging

## Goal

Turn the worker runtime from "runs under the test harness" into a
deployable surface that systemd can manage on a generic VM. After this
phase, the worker shipping path described in
[`docs/deployment/worker-systemd.md`](../../deployment/worker-systemd.md)
maps one-to-one to artifacts and code in this repo: `npm run worker`
starts a real worker, SIGTERM drains it cleanly, transient transport
drops are absorbed by an in-process reconnect loop, and the systemd
unit + env template ship from `deploy/`.

This phase is intentionally small. Phases 1–5 land the moving parts
(registry, transport, lease, reconnect frame, shutdown frame); phase 6
is the lifecycle and packaging glue that sits on top.

## Background

### Phases 1–5 prerequisites (assumed)

- **Phase 1** — registry-plane frames `register`, `heartbeat`,
  `reconnect`, `worker_shutdown`. Schemas defined; orchestrator-side
  reconcile logic for `reconnect`/`worker_shutdown` lives in step 1.4.
- **Phase 2** — `worker-entry-remote.ts` runs the worker bootstrap;
  reads task payload from network IPC; resolves `<worker-fs-root>`
  from `GVC0_WORKER_FS_ROOT`.
- **Phase 5** — `worker_shutdown` ack moves the lease to `released`
  (skips grace); reconnect with same `bootEpoch` reattaches without
  fence rotation; reconnect with different `bootEpoch` triggers
  takeover.

### Verified gaps on `main` after phases 1–5

- `package.json` has no `worker` script. The integration tests invoke
  `worker-entry-remote.ts` via `tsx` with hand-built env — fine for
  tests, not a deployment surface.
- `src/runtime/remote/worker-entry-remote.ts` has no signal handlers.
  SIGTERM from systemd kills the process immediately; in-flight leases
  must wait `leaseTtlMs + leaseGraceMs` (45s default) before takeover.
- No worker-side reconnect loop. Phase 1 step 1.2 ships the
  `reconnect` frame *schema* and phase 1 step 1.4 wires the
  *orchestrator-side* reconcile, but `WorkerRegistryClient` (phase 1
  step 1.5) is documented as "dial server, send register, await
  register_ack, start heartbeat interval, expose close()" — explicitly
  no reconnect logic. Phase 5 *assumes* workers reconnect
  (step 5.7 cases 1, 2, 7) but does not say where the loop lives. A
  transient transport drop currently terminates the worker; systemd
  `Restart=always` rotates `bootEpoch` and forces takeover — wasted
  work for a 2s network glitch.
- No SIGTERM handler. No phase doc requires the worker entry to trap
  SIGTERM and emit `worker_shutdown`; `worker-systemd.md` flags this
  as an unverified assumption.
- No `bootEpoch` source. Phase 1 D1 and phase 5 D7 specify "fresh per
  process start, stable across reconnects within a process" but no
  step actually generates the value.
- The only env validation is whatever the call sites do ad-hoc;
  missing `GVC0_WORKER_SECRET` surfaces as a TypeBox reject at the
  registry handshake, several function calls deep, hard to read in
  journald.
- Env-prefix drift. Phases 1 / 4 use `GVC_*` (`GVC_WORKER_PROTOCOL_TOKEN`
  on `workerProtocol.sharedSecret`; `GVC_FORCE_REMOTE_AGENTS` on the
  phase-4 lint guard). Phase 2 and `worker-systemd.md` use `GVC0_*`
  (`GVC0_WORKER_FS_ROOT`, `GVC0_ORCHESTRATOR_URL`, …). One prefix has
  to win before the validator lands.
- No `deploy/` directory. The systemd unit + env template in
  `docs/deployment/worker-systemd.md` are operator-copyable but not
  installable from the repo.
- No structured-log convention. Multi-line stack traces interleave
  badly in journald; downstream filtering needs single-line JSON.
- Initial-connect failure (worker boots while orchestrator is down)
  is not specified by any phase. The handshake spec assumes a
  successful TCP connect.

### Design decisions

- **Restart-always *and* reconnect.** Both cover different failure
  modes. Reconnect handles transient drops with same `bootEpoch`
  (cheap reattach, no takeover). Systemd `Restart=always` handles
  process crashes — the respawned worker picks a fresh `bootEpoch`,
  re-registers, and any orphaned leases expire and reroute via the
  phase 5 sweep. Worker code does not try to be its own supervisor.
- **Reconnect bounds.** Exponential backoff `250ms → 30s` cap with
  ±25% jitter. Reset on successful `reconnect_ack`. Give up after
  5 min of unbroken failures and exit with code `2`; systemd respawns
  with a fresh `bootEpoch`. The cap is *not* about lease holding —
  phase 5 leases are gone after `leaseTtlMs + leaseGraceMs` (45s
  default), well before 5 min — it's about not wasting CPU on an
  optimistic backoff schedule once the network has clearly stayed
  dead, and about ensuring the worker eventually re-registers with a
  fresh epoch (which is the only path that re-creates the orchestrator
  side state if the orchestrator itself was restarted).
- **Initial-connect failures use the same loop.** A worker that boots
  while the orchestrator is unreachable goes through the same
  backoff schedule. There is no "first connect" special case; the
  give-up timer starts from the first connect attempt. After give-up,
  exit `2` and systemd respawns from scratch.
- **`bootEpoch` is `Date.now()` at process start.** Generated once in
  `runWorker`, immutable for the lifetime of the process. Reconnects
  reuse it; only systemd respawn gets a new value. Clock-based
  satisfies "monotonic per worker incarnation" without persisting a
  counter file. Worst-case clock skew on a single VM between reboots
  is a few ms; collisions across reboots within the same millisecond
  are not a correctness issue (the orchestrator-side reconcile only
  cares about *equality* with the last-known epoch for the same
  `workerId`, not strict monotonicity).
- **SIGTERM drives drain, SIGINT mirrors it.** systemd sends SIGTERM
  by default; the same handler runs on SIGINT for interactive
  `Ctrl+C`. SIGKILL is unhandleable and falls through to lease
  expiry — that is the safety net.
- **Drain timeout.** `60_000ms` hard cap, paired with an explicit
  `TimeoutStopSec=120` in the systemd unit. The default
  `DefaultTimeoutStopSec` varies across distros (Debian/Ubuntu: 90s,
  Alpine: 5s) — relying on the inherited default would SIGKILL the
  drain on Alpine before any frame leaves the process. The drain
  emits `worker_shutdown` (`reason: 'graceful'`) with the current
  `inFlightLeases` set, awaits `worker_shutdown_ack`, then
  `process.exit(0)`. On timeout, exit `1`; phase 5's TTL+grace
  reroutes the runs.
- **Env prefix is `GVC0_*` everywhere.** Phase 1 / 4 introductions of
  `GVC_WORKER_PROTOCOL_TOKEN` and `GVC_FORCE_REMOTE_AGENTS` get
  renamed to `GVC0_WORKER_PROTOCOL_TOKEN` and `GVC0_FORCE_REMOTE_AGENTS`
  in step 6.2 alongside the validator. Picked `GVC0_*` because it
  matches the operator-facing artifact (`worker-systemd.md`) and
  phase 2's already-shipped `GVC0_WORKER_FS_ROOT`; renaming fewer
  tokens is the cheaper end of the rename.
- **Env validation is fail-fast.** Required keys
  (`GVC0_ORCHESTRATOR_URL`, `GVC0_WORKER_SECRET`, `GVC0_WORKER_ID`)
  missing → exit `64` (`EX_USAGE`) with a single-line JSON error
  naming every missing/invalid key. Unknown `GVC0_*` vars log a
  warning but do not block boot — operators add new env vars before
  upgrading the worker binary; warning surfaces drift without a hard
  break.
- **`transportKind` is implicit, not env-driven.** The
  `worker-entry-remote.ts` bootstrap always declares
  `transportKind: 'remote-ws'` in its `register` frame because the
  *file* is the remote-WS variant — local-spawn workers go through
  `worker/entry.ts` and register in-process with `workerId='local'`
  per phase 1 D2. No `GVC0_WORKER_TRANSPORT_KIND` env exists; if a
  third transport ever ships, the new entry file pins the new value.
- **Single invocation form: `npm run worker`.** No `bin` field in
  `package.json`. A `bin` entry would point at compiled JS that this
  repo does not currently build, and the operator narrative
  (`worker-systemd.md`) only ever uses `ExecStart=/usr/bin/npm run
  worker`. The script form is `tsx bin/worker.ts`; `tsx` is already
  a dev dep. Global install (`npm install -g`) is out of scope.
- **Structured logs are JSON-per-line.** Errors are serialized as
  `{ msg, stack: stack.split('\n').slice(0, 4).join(' ⏎ ') }` so a
  stack trace stays on one line. No new logging dependency — a
  one-file `console.log(JSON.stringify(...))` wrapper. Every line
  carries `t` (ISO ts), `lvl` (`info` / `warn` / `error`),
  `workerId`, `bootEpoch`, `msg`, plus topic-specific keys.
  `workerId`/`bootEpoch` on every line lets log aggregators filter
  by worker incarnation without joining against another stream.
- **Logs go to stdout/stderr.** systemd captures both into journald;
  no log file management in the worker. `info` and `warn` to stdout,
  `error` to stderr — `journalctl` shows priority correctly via the
  systemd `SyslogLevel` mapping.
- **Deploy artifacts live under `deploy/`, not `docs/`.** The unit
  file and env template are checked-in, version-controlled,
  installable artifacts. `docs/deployment/worker-systemd.md` keeps
  the *operator* narrative (when to use, why this shape, anti-
  patterns); `deploy/systemd/*` carries the *files* the operator
  drops onto the VM. The two stay in sync via a "the canonical unit
  lives at `deploy/systemd/gvc0-worker.service`" pointer in the doc.

### What this phase is **not**

- Not a packaging system. No `.deb`, no Docker image, no Helm chart.
  The deployment story is "git clone + npm ci + systemd". Operators
  who need a different shape can build it on top.
- Not auto-update. `git pull && systemctl restart gvc0-worker` is
  the upgrade path.
- Not TLS termination. A reverse proxy in front of the registry
  endpoint handles that; the worker speaks plain WebSocket.
- Not the bare-repo SSH wrapper. Phase 2 owns the git transport
  layer; this phase only documents that the worker user needs an
  ssh key on the deploy VM.

## Steps

The phase ships as **6 commits**. Each stands alone; the test suite
stays green between commits.

---

### Step 6.1 — `npm run worker` script + `bootEpoch` generation

**What:** wire `bin/worker.ts` as a thin entry, expose it through
`npm run worker`, and generate the per-process `bootEpoch` in
`runWorker` so it survives reconnects (step 6.4) but rotates on
systemd respawn.

**Files:**

- `bin/worker.ts` — new. ~10 lines: imports `runWorker` from
  `src/runtime/remote/worker-entry-remote.ts`, calls
  `process.exit(await runWorker(process.env))`. No
  `import.meta.main` guard; this file is the entry point and is
  always invoked as the main module.
- `package.json` — add `"scripts": { "worker": "tsx bin/worker.ts" }`.
  No `"bin"` field; the operator-facing form is `npm run worker`,
  and global-install / compiled-binary support is out of scope per
  the design block.
- `src/runtime/remote/worker-entry-remote.ts` — extract the bootstrap
  into an exported `runWorker(env: NodeJS.ProcessEnv): Promise<number>`
  function returning an exit code. Inside `runWorker`, generate
  `const bootEpoch = Date.now()` once and thread it through
  registration, heartbeat, and reconnect calls. Phase-2 callers
  (the integration tests that previously imported the module for
  side effects) move to calling `runWorker(env)` directly in the
  same commit.

**Tests:**

- `test/integration/remote/worker-entry-spawn.test.ts` — spawn
  `npm run worker` as a child process against a faux orchestrator;
  assert it registers (with a `bootEpoch` matching the spawn time
  ±1s), runs one task, exits cleanly.
- `test/unit/runtime/remote/worker-entry-bootepoch.test.ts` — call
  `runWorker` twice in one process (e.g. after a stub-driven exit);
  assert the two `register` frames carry distinct `bootEpoch`
  values (proves the value is per-`runWorker` call, not module-level).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the entry: (1) `runWorker` is the only place worker
> bootstrap code runs — no module-level side effects in
> `worker-entry-remote.ts` (grep for top-level `await` and
> top-level `process.on(...)` outside `runWorker`); (2)
> `bootEpoch` is generated exactly once per `runWorker` call,
> threaded into every `register` / `reconnect` / `heartbeat`
> frame, and never re-read from the clock after the initial
> capture; (3) `bin/worker.ts` does not import from `test/`;
> (4) `package.json` has the `worker` script and no `bin`
> field. Under 300 words.

**Commit:** `feat(runtime/remote): npm run worker entry + bootEpoch generation`

---

### Step 6.2 — Env validation with fail-fast errors

**What:** validate `GVC0_*` vars before any network/IO. Missing
required vars exit `64` with a single-line JSON error listing every
missing or invalid key. Unknown `GVC0_*` vars log a warning.

**Files:**

- `src/runtime/remote/worker-env.ts` — new. Exports
  `parseWorkerEnv(env: NodeJS.ProcessEnv): { ok: true; config:
  WorkerConfig } | { ok: false; missing: string[]; invalid:
  Array<{ key: string; reason: string }> }`. Required:
  `GVC0_ORCHESTRATOR_URL` (must parse via `new URL(...)` and have
  protocol `ws:` or `wss:`), `GVC0_WORKER_SECRET` (non-empty),
  `GVC0_WORKER_ID` (non-empty, matches `/^[A-Za-z0-9_-]{1,64}$/`).
  Optional: `GVC0_WORKER_FS_ROOT` (default `~/.gvc0/worker`),
  `GVC0_WORKER_CAPABILITIES` (default `task,feature_phase`,
  parsed to `RunScope['kind'][]`),
  `GVC0_WORKER_HARNESS_KINDS` (default `pi-sdk`, parsed to
  `HarnessKind[]`), `GVC0_WORKER_MAX_CONCURRENT` (default `2`,
  must parse to a positive integer). `transportKind` is **not**
  env-driven — `worker-entry-remote.ts` always declares
  `'remote-ws'` per the design block; the local-spawn path has
  its own entry file with its own pinned value.
- `bin/worker.ts` — call `parseWorkerEnv(env)` first; on failure
  print the error JSON to stderr and `process.exit(64)`.
- `src/runtime/remote/worker-entry-remote.ts` — `runWorker` accepts
  the parsed `WorkerConfig` rather than re-reading env scattered
  across the bootstrap.
- **Prefix rename across phases 1 / 4.** Phase 1 step 1.5 ships
  `workerProtocol.sharedSecret` overridable via `GVC_WORKER_PROTOCOL_TOKEN`;
  phase 4 step 4.9 ships the lint-bypass env `GVC_FORCE_REMOTE_AGENTS`.
  Both rename to the `GVC0_*` prefix in this commit so the operator-
  facing surface is consistent. Touch points: `src/config.ts` (read
  site for `workerProtocol.sharedSecret`); `eslint.config.js` (read
  site for `GVC0_FORCE_REMOTE_AGENTS`). No other call sites; the
  rename is a sed across two files plus their tests.

**Tests:**

- `test/unit/runtime/remote/worker-env.test.ts` — every required-var
  missing path; URL parse failure; non-`ws[s]:` protocol; invalid
  worker id; non-numeric `MAX_CONCURRENT`; capabilities with
  unknown scope kind; unknown `GVC0_*` var surfaces as a warning
  not an error; defaults applied when optional keys absent.
- Existing tests for `workerProtocol.sharedSecret` and the phase-4
  lint guard get retargeted to the new env names.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify env validation: (1) every required key has both a
> presence and a shape check; (2) the failure JSON includes the
> key name verbatim so an operator can grep journald for it; (3)
> defaults match the values printed in
> `docs/deployment/worker-systemd.md` and
> `deploy/systemd/worker.env.example`; (4) the validator is the
> only env-reading path in the worker bootstrap — grep
> `process.env\.GVC0_` outside this file should be empty after
> the change; (5) no `GVC_*` prefix remains anywhere in the repo
> except in changelog/git history (grep `GVC_` source-side); (6)
> `transportKind` is hardcoded to `'remote-ws'` in
> `worker-entry-remote.ts` and is *not* read from env. Under
> 350 words.

**Commit:** `feat(runtime/remote): worker env validator + GVC0_ prefix consolidation`

---

### Step 6.3 — SIGTERM-driven orderly drain

**What:** install a SIGTERM/SIGINT handler that fires the phase-1.2
`worker_shutdown` frame with the current in-flight lease set, awaits
`worker_shutdown_ack`, and exits cleanly. On timeout, exit non-zero
and let phase-5 TTL handle the runs.

**Files:**

- `src/runtime/remote/worker-shutdown.ts` — new. Exports
  `installShutdownHandler(opts: { sendShutdown: () =>
  Promise<void>; drainTimeoutMs: number; logger: Logger }): () =>
  void`. Returns a remover. Listens on SIGTERM and SIGINT; the
  first signal fires drain; subsequent signals during drain are
  noted in the log but do not double-fire. After drain or
  timeout, `process.exit(code)` directly.
- `src/runtime/remote/worker-entry-remote.ts` — install the handler
  with `drainTimeoutMs: 60_000`. `sendShutdown` builds the
  `worker_shutdown` frame from the local lease cache (the worker
  knows which `(agentRunId, fence)` pairs it currently holds —
  same source the heartbeat uses) and awaits the ack via the
  existing registry transport.

**Tests:**

- `test/unit/runtime/remote/worker-shutdown.test.ts` — fake clock +
  fake transport: SIGTERM fires send; ack within timeout exits 0;
  no ack within `drainTimeoutMs` exits 1; second SIGTERM during
  drain logs "already draining" and does not re-send.
- `test/integration/distributed/orderly-drain.test.ts` — full loop:
  dispatch one run → SIGTERM the worker → assert orchestrator
  receives `worker_shutdown` → orchestrator marks the lease
  `released` (phase-5 step 5.4 path) → worker exits 0 → next
  scheduler tick reroutes the run via the standard expired-lease
  reroute event.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify drain: (1) SIGTERM fires `worker_shutdown` exactly once
> per process even on repeated signals; (2) the frame's
> `inFlightLeases` matches the worker's current lease cache (no
> stale or speculative entries); (3) drain timeout falls through
> to `process.exit(1)` rather than hanging; (4) the integration
> test asserts the lease moves to `released` (not `expired`) on
> the orchestrator side; (5) no other code path calls
> `process.exit` from within the worker bootstrap (grep
> `process\.exit` under `src/runtime/remote/`). Under 350 words.

**Commit:** `feat(runtime/remote): SIGTERM-driven orderly drain`

---

### Step 6.4 — Reconnect-with-bounded-backoff loop

**What:** absorb transient transport drops in-process so a 2s
network blip does not rotate `bootEpoch` and trigger lease takeover.
Same loop covers initial-connect failure (worker boots while
orchestrator is down). Bounded so a stuck worker eventually exits
and lets systemd respawn from scratch.

**Files:**

- `src/runtime/remote/reconnect.ts` — new. Exports
  `runReconnectLoop(opts: { connect: () =>
  Promise<RegistryConnection>; onConnected: (conn,
  isFirstConnect) => Promise<'closed' | 'shutdown'>; clock: Clock;
  backoff?: BackoffConfig; giveUpAfterMs?: number }):
  Promise<'gave_up' | 'shutdown'>`. Default backoff: initial
  `250ms`, cap `30_000ms`, factor `2`, jitter `±25%`. Default
  `giveUpAfterMs: 300_000` (5 min) measured from the *first*
  connect attempt; successful `register_ack` or `reconnect_ack`
  resets both the backoff delay and the deadline. The
  `isFirstConnect` flag lets the caller pick `register` (no held
  leases) vs `reconnect` (held leases from prior session).
- `src/runtime/remote/worker-entry-remote.ts` — wrap the registry
  connection in `runReconnectLoop`. First successful connect
  sends a phase-1 `register` frame; subsequent reconnects send a
  phase-1.2 `reconnect` frame with held leases (read from the
  same in-process lease cache the heartbeat uses). `bootEpoch`
  stays stable across reconnects within one process. On
  `gave_up`, exit `2`; systemd respawns with a fresh `bootEpoch`,
  the orchestrator-side reconcile sees a different epoch for the
  same `workerId`, and phase-5 takeover handles the held leases.
- `src/config.ts` — add `workerReconnect: { initialDelayMs: 250,
  maxDelayMs: 30_000, factor: 2, jitterPct: 0.25, giveUpAfterMs:
  300_000 }` consumed by `runReconnectLoop` and overridable for
  tests.

**Tests:**

- `test/unit/runtime/remote/reconnect.test.ts` — fake clock asserts
  the backoff schedule (1st: 250±62ms, 2nd: 500±125ms, …, capped at
  30_000ms); jitter is bounded; `gave_up` fires at exactly the
  configured deadline; successful connect resets the schedule;
  `isFirstConnect=true` only on the very first `onConnected` call.
- `test/integration/distributed/worker-initial-connect-failure.test.ts`
  — start the worker against an orchestrator that is initially
  unreachable; bring the orchestrator up after 2s; assert the
  worker's first `register` frame arrives within one backoff window
  of the orchestrator coming up.
- `test/integration/distributed/worker-reconnect.test.ts` —
  orchestrator drops the worker connection mid-run; worker
  reconnects within 1s with the same `bootEpoch`; phase-1 reconcile
  branch routes through the same-bootEpoch reattach path; lease
  unchanged; run continues to completion.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify reconnect: (1) `bootEpoch` (from step 6.1) stays constant
> across all `connect` attempts within one `runReconnectLoop`
> invocation; (2) the *first* successful connect sends `register`,
> *subsequent* successes send `reconnect` (phase 1.2) — the
> `isFirstConnect` flag is the discriminator; (3) the give-up path
> exits the process via the bubble-up to `bin/worker.ts`, not via
> `process.exit` inside the loop; (4) backoff and the give-up
> deadline both reset on successful `register_ack` /
> `reconnect_ack`, not on any TCP-level reconnect — so a stuck
> orchestrator that accepts the socket but never acks does *not*
> reset the schedule; (5) the integration test asserts the lease's
> `state` and `fence` are unchanged across reconnect — proving the
> same-bootEpoch reattach branch fired, not takeover. Under 400
> words.

**Commit:** `feat(runtime/remote): bounded reconnect loop with backoff`

---

### Step 6.5 — Structured logs for journald

**What:** single-line JSON log format. No multi-line stack traces.
`info`/`warn` to stdout, `error` to stderr.

**Files:**

- `src/runtime/remote/log.ts` — new. Exports
  `createLogger(opts: { workerId: string; bootEpoch: number;
  stream?: { stdout: NodeJS.WritableStream; stderr:
  NodeJS.WritableStream } }): Logger` where `Logger` has
  `info(msg, fields?)`, `warn(msg, fields?)`, `error(msg, err?,
  fields?)`. Output: one `JSON.stringify({ t, lvl, workerId,
  bootEpoch, msg, ...fields })` per `\n`. Errors serialize as
  `{ ...fields, errMsg: err.message, errStack:
  err.stack?.split('\n').slice(0, 4).join(' ⏎ ') }`.
- `src/runtime/remote/worker-entry-remote.ts` — replace any
  `console.log` / `console.error` with the structured logger.
- `bin/worker.ts` — env-validation failure path uses the same
  format (still single-line JSON to stderr) so journald shows
  consistent shape across boot failures and run-time logs.

**Tests:**

- `test/unit/runtime/remote/log.test.ts` — every emit produces
  exactly one `\n`; nested newlines in messages or stack traces
  are escaped or replaced; `error` writes to stderr; `info` and
  `warn` write to stdout; `t` is ISO 8601; required fields
  (`workerId`, `bootEpoch`) appear on every line.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify logging: (1) every line emitted by the worker is exactly
> one `\n`-terminated JSON object — multi-line stack traces are
> joined; (2) `console.log` / `console.error` are not called from
> any file under `src/runtime/remote/` or `bin/`; (3) the field
> set on every line includes `workerId` and `bootEpoch` so log
> aggregators can filter; (4) stream split is honored: `error`
> writes to stderr, others to stdout. Under 250 words.

**Commit:** `feat(runtime/remote): structured single-line JSON logs`

---

### Step 6.6 — Deploy artifacts (systemd unit + env template)

**What:** ship the canonical systemd unit and env template from
`deploy/`. The operator narrative in `worker-systemd.md` points at
these files rather than inlining their contents — drift surfaces as
a missing-pointer rather than a stale code block.

**Files:**

- `deploy/systemd/gvc0-worker.service` — new. Canonical unit.
  Includes `TimeoutStopSec=120` (the 60s drain in step 6.3 is well
  inside this window; default `DefaultTimeoutStopSec` varies across
  distros and would SIGKILL the drain on Alpine). Top-of-file
  comment: "Canonical unit. Edit here, not in
  `/etc/systemd/system/`. See
  `docs/deployment/worker-systemd.md` for install narrative."
- `deploy/systemd/worker.env.example` — new. Documented env
  template covering every key the validator from step 6.2
  recognizes, with required keys uncommented at sentinel values
  (`<set-me>` placeholders, never real tokens) and optional keys
  commented out at their defaults.
- `deploy/README.md` — new. ~20 lines. Pointer to
  `docs/deployment/worker-systemd.md`; explicit note that the
  files in this directory are the canonical source and the doc is
  the narrative.
- `docs/deployment/worker-systemd.md` — replace the inline unit
  block and env block with **fenced previews extracted at render
  time** plus a "canonical: `deploy/systemd/...`" caption. The doc
  no longer pretends to be authoritative on directive contents;
  the review subagent enforces that the preview text comes from
  the canonical file (see review prompt). Add `TimeoutStopSec=120`
  to the unit narrative so the operator-facing text is accurate
  even before the canonical file lands.

**Tests:**

- No automated tests; config artifacts only. The drift guard is
  the review subagent below — it diffs the canonical file against
  the preview in the doc and rejects any mismatch.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify deploy artifacts: (1) `diff
> deploy/systemd/gvc0-worker.service <(extract the fenced unit
> block from docs/deployment/worker-systemd.md)` is empty — the
> doc preview and canonical file are byte-identical, no drift; (2)
> the env template covers every key recognized by `parseWorkerEnv`
> (cross-reference step 6.2) and no others; (3) env defaults match
> the validator defaults exactly; (4) `TimeoutStopSec=120` is
> present in the unit; (5) no secret values land in the example
> file (placeholders only — `<set-me>`, never a real token); (6)
> `docs/deployment/worker-systemd.md` cites `deploy/systemd/...`
> as the canonical source and does not claim to be authoritative
> on directive contents. Under 350 words.

**Commit:** `chore(deploy): canonical systemd unit + env template`

---

## Phase exit criteria

- All six commits land in order on a feature branch.
- `npm run verify` passes on the final commit.
- A clean checkout on a fresh VM can run, in order:
  `npm ci && cp deploy/systemd/worker.env.example /etc/gvc0/worker.env
  && (edit) && cp deploy/systemd/gvc0-worker.service
  /etc/systemd/system/ && systemctl daemon-reload && systemctl
  start gvc0-worker` and the worker registers, takes a run, and
  drains cleanly on `systemctl stop gvc0-worker`.
- `test/integration/distributed/` covers: missing required env →
  exit 64; spawned worker registers and runs one task; SIGTERM →
  `worker_shutdown` → lease released → exit 0; transport drop →
  reconnect with same `bootEpoch` → run continues; initial-connect
  failure (orchestrator down at boot) → backoff loop → eventual
  successful `register`; reconnect give-up → exit 2.
- `deploy/systemd/gvc0-worker.service` is the canonical unit and
  the fenced preview in `docs/deployment/worker-systemd.md` is a
  byte-identical extract — verifiable via the step 6.6 review-
  subagent diff.
- Every `GVC_*` env reference (phase 1 `GVC_WORKER_PROTOCOL_TOKEN`,
  phase 4 `GVC_FORCE_REMOTE_AGENTS`) has been renamed to `GVC0_*`;
  source-side grep for `GVC_` returns nothing outside changelog
  and git history.

## Out of scope (and rationale)

- **Container images / Dockerfile.** The deployment story is
  long-lived VMs with persistent scratch space; container images
  are a different lifecycle and would need their own phase.
- **`.deb` / `.rpm` packaging.** `git clone + npm ci` is the path.
  Distros that need package management can wrap this.
- **Auto-update.** `git pull && systemctl restart gvc0-worker` is
  the documented upgrade. Continuous delivery is an orthogonal
  concern.
- **Bare-repo SSH key provisioning.** The git transport setup
  (orchestrator-side `git-shell` user, deploy key on the worker)
  is documented in `worker-systemd.md` but not automated. Phase 2
  owns the bare-repo protocol; phase 6 does not regress that
  boundary.
- **TLS termination.** A reverse proxy in front of the registry
  endpoint handles wss; the worker speaks `ws:` or `wss:` based on
  `GVC0_ORCHESTRATOR_URL`. Cert management is operator turf.
- **Health-check endpoint.** systemd does not need one — the lease
  layer is the source of truth for liveness, and `Restart=always`
  catches process death. Adding `Type=notify` with sd_notify is
  deferred until the lease layer surfaces a use case (e.g. delaying
  reroute until the new worker has registered).

## Effect on the rest of the track

After this phase merges, `worker-systemd.md` becomes the operator's
single point of reference: install steps, environment file, unit
file, and run/stop semantics all map to checked-in artifacts and
code. The track's deployment story is closed. Subsequent work
(observability, multi-region, container images) builds on this
surface rather than rewriting it.
