# Phase 6 — Deployment packaging

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-1-protocol-and-registry (registry frames `register`/`heartbeat`, `bootEpoch` contract, `workerProtocol.sharedSecret`), phase-2-remote-task-execution (worker-entry bootstrap, `GVC0_WORKER_FS_ROOT`), phase-4-remote-feature-phases (lint guard + `GVC_FORCE_REMOTE_AGENTS`), phase-5-leases-and-recovery (`worker_shutdown` ack→released path, same-bootEpoch reconnect reattach, takeover on bootEpoch change)
- Default verify: npm run check:fix && npm run check
- Phase exit verify: npm run verify
- Phase exit smoke: clean-VM install path: `useradd --system --home-dir /var/lib/gvc0 --shell /usr/sbin/nologin gvc0 && install -d -o gvc0 -g gvc0 /var/lib/gvc0/scratch && install -d -o root -g gvc0 -m 0750 /etc/gvc0 && npm ci && install -o root -g gvc0 -m 0640 deploy/systemd/worker.env.example /etc/gvc0/worker.env && (edit) && cp deploy/systemd/gvc0-worker.service /etc/systemd/system/ && systemctl daemon-reload && systemctl start gvc0-worker` — worker registers as `gvc0:gvc0`, takes a run, drains cleanly on `systemctl stop gvc0-worker`. Verify with `systemctl show -p MainPID gvc0-worker` + `ps -o user= -p <pid>` returning `gvc0` (not `root`).
- Doc-sweep deferred: docs/deployment/worker-systemd.md (replace inline unit/env blocks with fenced previews + canonical pointer; add `TimeoutStopSec=120` to the unit narrative)

Ships as 6 commits, in order.

## Contract

- Goal: turn the worker runtime from "runs under the test harness" into a deployable surface that systemd can manage on a generic VM. After this phase, `npm run worker` starts a real worker, SIGTERM drains it cleanly, transient transport drops are absorbed by an in-process reconnect loop, and the systemd unit + env template ship from `deploy/`.
- Scope:
  - In:
    - `npm run worker` script + `bin/worker.ts` entry.
    - `bootEpoch = Date.now()` generation at process start in `runWorker`.
    - Fail-fast env validation via `parseWorkerEnv`; missing/invalid keys exit `64` with single-line JSON error.
    - SIGTERM-driven orderly drain (60s budget under `TimeoutStopSec=120`).
    - Reconnect loop with exponential backoff (250ms → 30s, ±25% jitter, 5 min give-up → exit `2`).
    - Structured single-line JSON logs to stdout/stderr for journald.
    - Canonical systemd unit at `deploy/systemd/gvc0-worker.service` with required directives (`User=gvc0` / `Group=gvc0` / `NoNewPrivileges=true` / `ProtectSystem=strict` / `ReadWritePaths=/var/lib/gvc0` / `ProtectHome=true` / `PrivateTmp=true`).
    - `deploy/systemd/worker.env.example` covering every key `parseWorkerEnv` recognizes.
    - `useradd` + ownership setup in the install path.
    - Env-prefix rename `GVC_*` → `GVC0_*` (touches `GVC_WORKER_PROTOCOL_TOKEN` from phase-1-protocol-and-registry and `GVC_FORCE_REMOTE_AGENTS` from phase-4-remote-feature-phases).
  - Out:
    - Container images / `.deb` / `.rpm` packaging (no owner phase in this track).
    - Auto-update (no owner phase in this track).
    - TLS termination — operator-managed reverse proxy (no owner phase in this track).
    - Bare-repo SSH key provisioning (phase-2-remote-task-execution boundary).
    - Health-check endpoint — lease layer is the liveness source of truth; `sd_notify` deferred (no owner phase in this track).
    - End-user usage documentation (phase-7-usage-documentation).
- Exit criteria:
  - All six commits land in order; `npm run verify` passes on the final commit.
  - Phase exit smoke install path runs end-to-end: worker registers as `gvc0:gvc0`, takes a run, drains cleanly on `systemctl stop gvc0-worker`. Subprocess inheritance means the agent and its descendants run as the same uid.
  - Integration suite covers: missing-env → exit 64; spawn → register → run; SIGTERM → `worker_shutdown` → released → exit 0; transient drop → same-`bootEpoch` reconnect → run continues; orchestrator-down-at-boot → eventual register; reconnect give-up → exit 2.
  - Source-side `grep -RIn 'GVC_'` returns nothing outside git history.

## Plan

- Background: other phases in this track land the moving parts (registry, transport, lease, reconnect frame, shutdown frame); this phase is the lifecycle and packaging glue that sits on top. Gaps on `main` at the verified state: no `npm run worker` script, no signal handlers (SIGTERM from systemd kills immediately, forcing 45s lease-grace wait), no worker-side reconnect loop (phase-5-leases-and-recovery step 5.7 cases 1/2/7 assume one but no step wires it), no `bootEpoch` source (phase-1-protocol-and-registry D1 / phase-5-leases-and-recovery D7 specify the contract but no step generates the value), ad-hoc env validation, env-prefix drift (`GVC_*` vs `GVC0_*` across phase-1-protocol-and-registry / phase-4-remote-feature-phases vs phase-2-remote-task-execution), no `deploy/` directory, no structured-log convention, and no spec for initial-connect failure when orchestrator is down at boot.

Design decisions:
  - **Restart-always *and* reconnect.** Both cover different failure modes. Reconnect handles transient drops with same `bootEpoch` (cheap reattach, no takeover). Systemd `Restart=always` handles process crashes — the respawned worker picks a fresh `bootEpoch`, re-registers, and any orphaned leases expire and reroute via the `phase-5-leases-and-recovery` sweep. Worker code does not try to be its own supervisor.
  - **Reconnect bounds.** Exponential backoff `250ms → 30s` cap with ±25% jitter. Reset on successful `reconnect_ack`. Give up after 5 min unbroken failures, exit `2`; systemd respawns with a fresh `bootEpoch`. The 5-min cap is well past the 45s lease grace (leases are long gone) — it bounds CPU on a clearly-dead network and guarantees eventual fresh-epoch re-registration if the orchestrator itself was restarted.
  - **Initial-connect failures use the same loop.** A worker that boots while the orchestrator is unreachable goes through the same backoff schedule. There is no "first connect" special case; the give-up timer starts from the first connect attempt. After give-up, exit `2` and systemd respawns from scratch.
  - **`bootEpoch` is `Date.now()` at process start.** Generated once in `runWorker`, immutable for the process lifetime. Reconnects reuse it; only systemd respawn gets a new value. Orchestrator reconcile checks equality (not monotonicity), so same-millisecond reboot collisions are not a correctness issue.
  - **SIGTERM drives drain, SIGINT mirrors it.** systemd sends SIGTERM by default; the same handler runs on SIGINT for interactive `Ctrl+C`. SIGKILL is unhandleable and falls through to lease expiry — that is the safety net.
  - **Drain timeout.** `60_000ms` hard cap, paired with an explicit `TimeoutStopSec=120` in the systemd unit. The default `DefaultTimeoutStopSec` varies across distros (Debian/Ubuntu: 90s, Alpine: 5s) — relying on the inherited default would SIGKILL the drain on Alpine before any frame leaves the process. The drain emits `worker_shutdown` (`reason: 'graceful'`) with the current `inFlightLeases` set, awaits `worker_shutdown_ack`, then `process.exit(0)`. On timeout, exit `1`; the `phase-5-leases-and-recovery` TTL+grace reroutes the runs.
  - **Env prefix is `GVC0_*` everywhere.** Step 6.2 renames `GVC_WORKER_PROTOCOL_TOKEN` and `GVC_FORCE_REMOTE_AGENTS` to the `GVC0_*` prefix (matches the operator-facing `worker-systemd.md` and the `GVC0_WORKER_FS_ROOT` shipped by `phase-2-remote-task-execution`).
  - **Env validation is fail-fast.** Required keys (`GVC0_ORCHESTRATOR_URL`, `GVC0_WORKER_SECRET`, `GVC0_WORKER_ID`) missing → exit `64` (`EX_USAGE`) with a single-line JSON error naming every missing/invalid key. Unknown `GVC0_*` vars log a warning but do not block boot — operators add new env vars before upgrading the worker binary; warning surfaces drift without a hard break.
  - **`transportKind` is implicit.** `worker-entry-remote.ts` hardcodes `'remote-ws'`; local-spawn workers go through `worker/entry.ts` per `phase-1-protocol-and-registry` D2. No env switch — new transports get new entry files.
  - **Single invocation form: `npm run worker` → `tsx bin/worker.ts`.** No `bin` field; the repo does not build compiled JS, and `worker-systemd.md` uses `ExecStart=/usr/bin/npm run worker`. Global install out of scope.
  - **Structured logs are JSON-per-line.** Errors are serialized as `{ msg, stack: stack.split('\n').slice(0, 4).join(' ⏎ ') }` so a stack trace stays on one line. No new logging dependency — a one-file `console.log(JSON.stringify(...))` wrapper. Every line carries `t` (ISO ts), `lvl` (`info` / `warn` / `error`), `workerId`, `bootEpoch`, `msg`, plus topic-specific keys. `workerId`/`bootEpoch` on every line lets log aggregators filter by worker incarnation without joining against another stream.
  - **Logs go to stdout/stderr.** systemd captures both into journald; no log file management in the worker. `info` and `warn` to stdout, `error` to stderr — `journalctl` shows priority correctly via the systemd `SyslogLevel` mapping.
  - **Deploy artifacts live under `deploy/`, not `docs/`.** The unit file and env template are checked-in, version-controlled, installable artifacts. `docs/deployment/worker-systemd.md` keeps the *operator* narrative (when to use, why this shape, anti-patterns); `deploy/systemd/*` carries the *files* the operator drops onto the VM. The two stay in sync via a "the canonical unit lives at `deploy/systemd/gvc0-worker.service`" pointer in the doc.

- Notes:
  - Watch: `phase-2-remote-task-execution` integration tests previously imported `worker-entry-remote.ts` for side effects; they migrate to calling `runWorker(env)` directly in step 6.1's same commit.
  - Watch: env-prefix rename touches `src/config.ts` (read site for `workerProtocol.sharedSecret`) and `eslint.config.js` (read site for `GVC0_FORCE_REMOTE_AGENTS`). No other call sites; the rename is a sed across two files plus their tests.

## Steps

### 6.1 npm run worker entry + bootEpoch generation [risk: med, size: M]

What: wire `bin/worker.ts` as a thin entry, expose it through `npm run worker`, and generate the per-process `bootEpoch` in `runWorker` so it survives reconnects (step 6.4) but rotates on systemd respawn.

Files:
  - `bin/worker.ts` — new. ~10 lines: imports `runWorker` from `src/runtime/remote/worker-entry-remote.ts`, calls `process.exit(await runWorker(process.env))`. No `import.meta.main` guard; this file is the entry point and is always invoked as the main module.
  - `package.json` — add `"scripts": { "worker": "tsx bin/worker.ts" }`. No `"bin"` field; the operator-facing form is `npm run worker`, and global-install / compiled-binary support is out of scope per the design block.
  - `src/runtime/remote/worker-entry-remote.ts` — extract the bootstrap into an exported `runWorker(env: NodeJS.ProcessEnv): Promise<number>` function returning an exit code. Inside `runWorker`, generate `const bootEpoch = Date.now()` once and thread it through registration, heartbeat, and reconnect calls. `phase-2-remote-task-execution` callers (the integration tests that previously imported the module for side effects) move to calling `runWorker(env)` directly in the same commit.

Tests:
  - `test/integration/remote/worker-entry-spawn.test.ts` — spawn `npm run worker` as a child process against a faux orchestrator; assert it registers (with a `bootEpoch` matching the spawn time ±1s), runs one task, exits cleanly.
  - `test/unit/runtime/remote/worker-entry-bootepoch.test.ts` — call `runWorker` twice in one process (e.g. after a stub-driven exit); assert the two `register` frames carry distinct `bootEpoch` values (proves the value is per-`runWorker` call, not module-level).

Review goals (cap 200 words):
  1. No module-level side effects in `worker-entry-remote.ts` outside `runWorker`.
  2. `bootEpoch` is generated once per `runWorker` call and threaded into every `register` / `reconnect` / `heartbeat` frame.
  3. `package.json` has the `worker` script, no `bin` field.

Commit: feat(runtime/remote): npm run worker entry + bootEpoch generation

### 6.2 Env validation with fail-fast errors [risk: high, size: M]

What: validate `GVC0_*` vars before any network/IO. Missing required vars exit `64` with a single-line JSON error listing every missing or invalid key. Unknown `GVC0_*` vars log a warning. This commit also renames `GVC_*` → `GVC0_*` across the two read sites left over from `phase-1-protocol-and-registry` and `phase-4-remote-feature-phases`.

Files:
  - `src/runtime/remote/worker-env.ts` — new. Exports `parseWorkerEnv(env: NodeJS.ProcessEnv): { ok: true; config: WorkerConfig } | { ok: false; missing: string[]; invalid: Array<{ key: string; reason: string }> }`. Required: `GVC0_ORCHESTRATOR_URL` (must parse via `new URL(...)` and have protocol `ws:` or `wss:`), `GVC0_WORKER_SECRET` (non-empty), `GVC0_WORKER_ID` (non-empty, matches `/^[A-Za-z0-9_-]{1,64}$/`). Optional: `GVC0_WORKER_FS_ROOT` (default `~/.gvc0/worker`), `GVC0_WORKER_CAPABILITIES` (default `task,feature_phase`, parsed to `RunScope['kind'][]`), `GVC0_WORKER_HARNESS_KINDS` (default `pi-sdk`, parsed to `HarnessKind[]`), `GVC0_WORKER_MAX_CONCURRENT` (default `2`, must parse to a positive integer). `transportKind` is **not** env-driven — `worker-entry-remote.ts` always declares `'remote-ws'` per the design block; the local-spawn path has its own entry file with its own pinned value.
  - `bin/worker.ts` — call `parseWorkerEnv(env)` first; on failure print the error JSON to stderr and `process.exit(64)`.
  - `src/runtime/remote/worker-entry-remote.ts` — `runWorker` accepts the parsed `WorkerConfig` rather than re-reading env scattered across the bootstrap.
  - `src/config.ts` — rename the read site for `workerProtocol.sharedSecret` from `GVC_WORKER_PROTOCOL_TOKEN` to `GVC0_WORKER_PROTOCOL_TOKEN`.
  - `eslint.config.js` — rename the read site for the lint-bypass env from `GVC_FORCE_REMOTE_AGENTS` to `GVC0_FORCE_REMOTE_AGENTS`.

Tests:
  - `test/unit/runtime/remote/worker-env.test.ts` — every required-var missing path; URL parse failure; non-`ws[s]:` protocol; invalid worker id; non-numeric `MAX_CONCURRENT`; capabilities with unknown scope kind; unknown `GVC0_*` var surfaces as a warning not an error; defaults applied when optional keys absent.
  - Existing tests for `workerProtocol.sharedSecret` and the `phase-4-remote-feature-phases` lint guard get retargeted to the new env names.

Review goals (cap 250 words):
  1. Every required key has both presence and shape checks.
  2. Failure JSON includes verbatim key names.
  3. The validator is the only env-reading path: `grep -RIn 'process.env\.GVC0_'` outside `worker-env.ts` is empty.
  4. No source-side `GVC_*` prefix remains.
  5. `transportKind` is hardcoded `'remote-ws'`, not env-driven.

Commit: feat(runtime/remote): worker env validator + GVC0_ prefix consolidation
Rollback: env-var rename — operators with `GVC_*` keys in `/etc/gvc0/worker.env` must edit them back to `GVC_*` after revert. `git revert` undoes the source side; the env file on disk is operator-owned.

### 6.3 SIGTERM-driven orderly drain [risk: high, size: M]

What: install a SIGTERM/SIGINT handler that fires the `phase-1-protocol-and-registry` `worker_shutdown` frame with the current in-flight lease set, awaits `worker_shutdown_ack`, and exits cleanly. On timeout, exit non-zero and let the `phase-5-leases-and-recovery` TTL handle the runs.

Files:
  - `src/runtime/remote/worker-shutdown.ts` — new. Exports `installShutdownHandler(opts: { sendShutdown: () => Promise<void>; drainTimeoutMs: number; logger: Logger }): () => void`. Returns a remover. Listens on SIGTERM and SIGINT; the first signal fires drain; subsequent signals during drain are noted in the log but do not double-fire. After drain or timeout, `process.exit(code)` directly.
  - `src/runtime/remote/worker-entry-remote.ts` — install the handler with `drainTimeoutMs: 60_000`. `sendShutdown` builds the `worker_shutdown` frame from the local lease cache (the worker knows which `(agentRunId, fence)` pairs it currently holds — same source the heartbeat uses) and awaits the ack via the existing registry transport.

Tests:
  - `test/unit/runtime/remote/worker-shutdown.test.ts` — fake clock + fake transport: SIGTERM fires send; ack within timeout exits 0; no ack within `drainTimeoutMs` exits 1; second SIGTERM during drain logs "already draining" and does not re-send.
  - `test/integration/distributed/orderly-drain.test.ts` — full loop: dispatch one run → SIGTERM the worker → assert orchestrator receives `worker_shutdown` → orchestrator marks the lease `released` (the `phase-5-leases-and-recovery` step 5.4 path) → worker exits 0 → next scheduler tick reroutes the run via the standard expired-lease reroute event.

Review goals (cap 250 words):
  1. SIGTERM fires `worker_shutdown` exactly once per process.
  2. `inFlightLeases` matches the worker's current cache.
  3. Drain timeout exits 1, never hangs.
  4. Integration test asserts lease moves to `released` (not `expired`) orchestrator-side.
  5. No other `process.exit` paths under `src/runtime/remote/`.

Commit: feat(runtime/remote): SIGTERM-driven orderly drain

### 6.4 Reconnect-with-bounded-backoff loop [risk: high, size: L]

What: absorb transient transport drops in-process so a 2s network blip does not rotate `bootEpoch` and trigger lease takeover. Same loop covers initial-connect failure (worker boots while orchestrator is down). Bounded so a stuck worker eventually exits and lets systemd respawn from scratch.

Files:
  - `src/runtime/remote/reconnect.ts` — new. Exports `runReconnectLoop(opts: { connect: () => Promise<RegistryConnection>; onConnected: (conn, isFirstConnect) => Promise<'closed' | 'shutdown'>; clock: Clock; backoff?: BackoffConfig; giveUpAfterMs?: number }): Promise<'gave_up' | 'shutdown'>`. Default backoff: initial `250ms`, cap `30_000ms`, factor `2`, jitter `±25%`. Default `giveUpAfterMs: 300_000` (5 min) measured from the *first* connect attempt; successful `register_ack` or `reconnect_ack` resets both the backoff delay and the deadline. The `isFirstConnect` flag lets the caller pick `register` (no held leases) vs `reconnect` (held leases from prior session).
  - `src/runtime/remote/worker-entry-remote.ts` — wrap the registry connection in `runReconnectLoop`. First successful connect sends a `phase-1-protocol-and-registry` `register` frame; subsequent reconnects send the `phase-1-protocol-and-registry` `reconnect` frame with held leases (read from the same in-process lease cache the heartbeat uses). `bootEpoch` stays stable across reconnects within one process. On `gave_up`, exit `2`; systemd respawns with a fresh `bootEpoch`, the orchestrator-side reconcile sees a different epoch for the same `workerId`, and `phase-5-leases-and-recovery` takeover handles the held leases.
  - `src/config.ts` — add `workerReconnect: { initialDelayMs: 250, maxDelayMs: 30_000, factor: 2, jitterPct: 0.25, giveUpAfterMs: 300_000 }` consumed by `runReconnectLoop` and overridable for tests.

Tests:
  - `test/unit/runtime/remote/reconnect.test.ts` — fake clock asserts the backoff schedule (1st: 250±62ms, 2nd: 500±125ms, …, capped at 30_000ms); jitter is bounded; `gave_up` fires at exactly the configured deadline; successful connect resets the schedule; `isFirstConnect=true` only on the very first `onConnected` call.
  - `test/integration/distributed/worker-initial-connect-failure.test.ts` — start the worker against an orchestrator that is initially unreachable; bring the orchestrator up after 2s; assert the worker's first `register` frame arrives within one backoff window of the orchestrator coming up.
  - `test/integration/distributed/worker-reconnect.test.ts` — orchestrator drops the worker connection mid-run; worker reconnects within 1s with the same `bootEpoch`; the `phase-1-protocol-and-registry` reconcile branch routes through the same-bootEpoch reattach path; lease unchanged; run continues to completion.

Review goals (cap 300 words):
  1. `bootEpoch` stays constant across all connect attempts within one loop.
  2. First connect sends `register`; subsequent connects send `reconnect`.
  3. Give-up bubbles up to `bin/worker.ts`; no in-loop `process.exit`.
  4. Backoff + give-up deadline reset on `register_ack` / `reconnect_ack` only — accepted-but-unacked socket does not reset.
  5. Integration test asserts lease `state` / `fence` unchanged across reconnect (proves same-bootEpoch reattach, not takeover).

Commit: feat(runtime/remote): bounded reconnect loop with backoff

### 6.5 Structured logs for journald [risk: low, size: M]

What: single-line JSON log format. No multi-line stack traces. `info`/`warn` to stdout, `error` to stderr.

Files:
  - `src/runtime/remote/log.ts` — new. Exports `createLogger(opts: { workerId: string; bootEpoch: number; stream?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } }): Logger` where `Logger` has `info(msg, fields?)`, `warn(msg, fields?)`, `error(msg, err?, fields?)`. Output: one `JSON.stringify({ t, lvl, workerId, bootEpoch, msg, ...fields })` per `\n`. Errors serialize as `{ ...fields, errMsg: err.message, errStack: err.stack?.split('\n').slice(0, 4).join(' ⏎ ') }`.
  - `src/runtime/remote/worker-entry-remote.ts` — replace any `console.log` / `console.error` with the structured logger.
  - `bin/worker.ts` — env-validation failure path uses the same format (still single-line JSON to stderr) so journald shows consistent shape across boot failures and run-time logs.

Tests:
  - `test/unit/runtime/remote/log.test.ts` — every emit produces exactly one `\n`; nested newlines in messages or stack traces are escaped or replaced; `error` writes to stderr; `info` and `warn` write to stdout; `t` is ISO 8601; required fields (`workerId`, `bootEpoch`) appear on every line.

Review goals (cap 200 words):
  1. Every line is one `\n`-terminated JSON object; multi-line stack traces are joined.
  2. No `console.log` / `console.error` under `src/runtime/remote/` or `bin/`.
  3. Every line has `workerId` and `bootEpoch`.
  4. `error` → stderr, others → stdout.

Commit: feat(runtime/remote): structured single-line JSON logs

### 6.6 Deploy artifacts (systemd unit + env template) [risk: high, size: M]

What: ship the canonical systemd unit and env template from `deploy/`. The operator narrative in `worker-systemd.md` points at these files rather than inlining their contents — drift surfaces as a missing-pointer rather than a stale code block.

Files:
  - `deploy/systemd/gvc0-worker.service` — new. Canonical unit. Required directives: `User=gvc0`, `Group=gvc0` (worker and every spawned descendant — pi-sdk `Agent`, verification `bash`, `git` against the bare repo — inherit the unprivileged uid; never run as root); `WorkingDirectory=/opt/gvc0`; `EnvironmentFile=/etc/gvc0/worker.env`; `NoNewPrivileges=true` (blocks setuid escalation in any descendant); `ProtectSystem=strict` + `ReadWritePaths=/var/lib/gvc0` (writes confined to the scratch root / `GVC0_WORKER_FS_ROOT`; repo checkout is RO at runtime); `ProtectHome=true`; `PrivateTmp=true`; `TimeoutStopSec=120` (60s drain fits; default varies per distro and SIGKILLs the drain on Alpine); `Restart=always`. Top comment points at `docs/deployment/worker-systemd.md`.
  - `deploy/systemd/worker.env.example` — new. Documented env template covering every key the validator from step 6.2 recognizes, with required keys uncommented at sentinel values (`<set-me>` placeholders, never real tokens) and optional keys commented out at their defaults.
  - `deploy/README.md` — new. ~20 lines. Pointer to `docs/deployment/worker-systemd.md`; explicit note that the files in this directory are the canonical source and the doc is the narrative.
  - `docs/deployment/worker-systemd.md` — replace the inline unit block and env block with **fenced previews extracted at render time** plus a "canonical: `deploy/systemd/...`" caption. The doc no longer pretends to be authoritative on directive contents; the review goal #1 below enforces that the preview text comes from the canonical file. Add `TimeoutStopSec=120` to the unit narrative so the operator-facing text is accurate even before the canonical file lands.

Tests: none — config artifacts only. The drift guard is the review goals below.

Review goals (cap 250 words):
  1. The canonical unit file and the doc's fenced preview are byte-identical (diff empty).
  2. Env template covers exactly the keys `parseWorkerEnv` recognizes; defaults match the validator.
  3. `TimeoutStopSec=120` is in the unit.
  4. `User=gvc0` and `Group=gvc0` are present (the unit MUST NOT run as root) and `NoNewPrivileges=true` / `ProtectSystem=strict` / `ReadWritePaths=/var/lib/gvc0` / `ProtectHome=true` / `PrivateTmp=true` are all present.
  5. No real secrets in the example file (placeholders only).
  6. `worker-systemd.md` cites `deploy/systemd/...` as canonical.

Commit: chore(deploy): canonical systemd unit + env template
Rollback: deploy artifacts already shipped — `git revert` removes the canonical files from the repo, but operators who copied `gvc0-worker.service` into `/etc/systemd/system/` must `systemctl stop gvc0-worker && systemctl disable gvc0-worker && rm /etc/systemd/system/gvc0-worker.service && systemctl daemon-reload` manually. `/etc/gvc0/worker.env` is operator-owned.
Smoke: see phase-exit smoke in the header — clean-VM install path; `systemctl show -p MainPID gvc0-worker` + `ps -o user= -p <pid>` returns `gvc0`.

---
Shipped in <SHA1>..<SHA6> on <YYYY-MM-DD>
