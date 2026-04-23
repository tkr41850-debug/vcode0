---
phase: 03-worker-execution-loop
verified: 2026-04-23T23:58:00Z
status: human_needed
score: 6/6 success criteria verified (programmatic); 1 live-provider human gate outstanding
re_verification:
  previous_status: null
  previous_score: null
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred:
  - truth: "Destructive-op `bypassOnce` map cannot honor an approval because pi-sdk rotates `toolCall.id` on retry"
    addressed_in: "Phase 7"
    evidence: "src/runtime/worker/index.ts L147-L150 comment: 'Phase 7 materializes a full approval-bypass protocol'; plan 03-04 decisions #4."
  - truth: "Non-git destructive commands (rm -rf, dd, mkfs, find -delete, chmod -R 000, sudo *) are not blocked by the guard"
    addressed_in: "Phase 7"
    evidence: "docs/concerns/destructive-ops-non-git.md + destructive-ops.ts L16-L24 scope comment."
  - truth: "ToolOutputStore is per-run, but the keying required to survive tool-retry across worker restarts (`{agentRunId, toolCallId}`) is not enforced yet"
    addressed_in: "Phase 9"
    evidence: "docs/spikes/pi-sdk-resume.md §Known limitations & follow-ups bullet 3: 'Phase 9 (crash recovery) will validate this keying.'"
  - truth: "Full crash-recovery UX on top of PID registry"
    addressed_in: "Phase 9"
    evidence: "CONTEXT.md §Scope Fences: 'this phase only persists PIDs'; plan 03-01 SUMMARY §Cross-Phase Hooks."
  - truth: "Inbox resolution UX / operator surface for destructive-action and semantic_failure rows"
    addressed_in: "Phase 7"
    evidence: "CONTEXT.md §D + plan 03-04 decisions #3: 'Phase 7 materializes a full approval-bypass protocol'; migration 0005 comment 'Phase 7 extends this schema with more columns + query helpers'."
human_verification:
  - test: "Re-run the pi-sdk resume spike against a live provider (Anthropic or OpenAI) and confirm the five-scenario matrix still lands `lastRole=assistant` on every resume-relevant path"
    expected: "Either the decision stands (live continue() still throws on terminal assistant) OR a concrete counter-observation triggers re-validation of the persist-tool-outputs choice"
    why_human: "The spike uses pi-ai's faux provider; streaming timing / tool-call packaging / token accounting differ on real providers. docs/spikes/pi-sdk-resume.md §Known limitations bullet 1 explicitly flags this. No way to run live providers from a verifier — requires API credentials + operator attention."
  - test: "Wire a real end-to-end worker through LocalWorkerPool with config.models.taskWorker pointing at a live provider, have it produce a real commit, and observe commit_done.sha + gvc0 trailer round-trip into agent_runs.last_commit_sha"
    expected: "agent_runs.last_commit_sha = the live SHA; git interpret-trailers --parse on the commit shows both gvc0-task-id and gvc0-run-id; scheduler observes no `commit_trailer_missing` event."
    why_human: "All unit + integration coverage uses faux streams or in-process harnesses. The full spawn→provider→git commit round-trip has never been exercised against a real process boundary in CI — Phase 3 SC #1 is only asserted through layered pieces, not one live run."
---

# Phase 3: Worker Execution Loop + Pi-SDK Spike — Verification Report

**Phase Goal (verbatim from CONTEXT):**
Ship a usable v1 worker loop end-to-end: NDJSON IPC, retry-policy, commit trailers for merge-train attribution, write-pre-hook claim-lock round trip, and a pi-sdk resume-fidelity spike to lock the two-tier pause strategy. The worker is process-per-task, isolated in a git worktree, and must be clean-recoverable via PID registry.

**Verified:** 2026-04-23T23:58:00Z
**Status:** human_needed (all programmatic SCs pass; two live-provider observation gates outstanding)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Worker forks in isolated worktree; PID persisted on start, cleared on exit | ✓ VERIFIED | `PiSdkHarness.forkWorker()` (harness/index.ts L218-L252) calls `child_process.fork` under `worktreePath(resolveTaskWorktreeBranch(task))`. `recordPid()` L203-L212 sets `pidRegistry.set(agentRunId, pid)` BEFORE any IPC frame handling. `createSessionHandle.fireExit` L280-L288 calls `onBeforeExitDispatch` (the clear) *before* user handlers. Registry maps directly to `agent_runs.worker_pid` (migration 0003 partial index). `test/integration/worktree-pid-registry.test.ts` (4/4 pass) covers start→clear, error→clear-before-user-handler, resume→clear, UPDATE-no-op on missing row. |
| 2 | NDJSON IPC: line-buffered, schema-validated, survives malformed, detects worker silence | ✓ VERIFIED | `NdjsonStdioTransport` (ipc/index.ts L79-L129) uses readline interface + `Value.Check` against typebox `WorkerToOrchestratorFrame`; parse/schema failures go to `Quarantine` (ring capacity 64 + `queueMicrotask` Store insert). Symmetric `ChildNdjsonStdioTransport` for the worker side. Heartbeat: harness sends `health_ping` every `workerHealthTimeoutMs/2` (harness/index.ts L305-L323); 2 consecutive missed pongs synthesize a terminal `error` frame with `kind: 'health_timeout'` and SIGKILL the child. Integration coverage: `worker-smoke.test.ts` "quarantines malformed stdout line" + "quarantines schema-mismatched frame" + "synthesizes error/health_timeout and SIGKILLs" all green. 16-test schema suite (`test/unit/ipc/frame-schema.test.ts`) + 9-test quarantine suite. |
| 3 | Retry policy distinguishes transient from semantic; inbox escalation stub | ✓ VERIFIED | Pure `decideRetry()` (retry-policy.ts L57-L84): `attempt >= maxAttempts` → escalate; non-transient (no regex match) → escalate immediately; transient → backoff `base*2^(n-1)` capped at `maxDelay` + [0,250)ms jitter. Wired via `LocalWorkerPool.handleErrorFrame` (worker-pool.ts L389-L438): retry path re-calls `dispatchTask` with cached payload (scheduler never sees transient); escalate path calls `store.appendInboxItem` with `kind: 'semantic_failure'` before forwarding. `buildRetryPolicyConfig(config)` compiles string patterns into `RegExp` once at compose time (`compose.ts` L235). Migration 0005 creates `inbox_items` with partial index on unresolved rows. Integration: `worker-retry-commit.test.ts` covers transient-redispatch-without-inbox + semantic-to-inbox + forward-error-frame, all green. 12-test unit suite for `decideRetry`. |
| 4 | `git commit` carries gvc0 trailers; `commit_done.sha` frame records SHA back | ✓ VERIFIED | Pure `commit-trailer.ts`: `isGitCommitCommand()` filters only `git commit` (not `git log`/`npm test`), `maybeInjectTrailer()` appends `--trailer "gvc0-task-id=..."` and `--trailer "gvc0-run-id=..."` idempotently (no-op when already present). Wired in `run-command.ts` L200-L249: on exit-0 commit, `git rev-parse HEAD` + `git interpret-trailers --parse` + `validateTrailers()` fire `onCommitDone(sha, trailerOk)` which the `WorkerRuntime` (worker/index.ts L126-L134) forwards as a `commit_done` NDJSON frame. `CommitDoneFrame` exists in the typebox schema (frame-schema.ts L429-L435). Orchestrator consumes via `scheduler/events.ts` L182-L193: persists `setLastCommitSha(run.id, sha)` (migration 0006) and emits a `commit_trailer_missing` event when `trailerOk=false`. Integration `worker-retry-commit.test.ts` "emits commit_done with trailerOk=true and persists the SHA" green. 13-test unit suite on the trailer helpers. |
| 5 | Write tool calls pass through a claim-lock round-trip (REQ-EXEC-04); denies abort cleanly | ✓ VERIFIED | `PathLockClaimer.claim()` (path-lock.ts L13-L27) emits `claim_lock` frame via `IpcBridge.claimLock`, blocks on a `claim_decision` response; `granted=false` throws `path lock denied: <paths>` which surfaces as a pi-sdk tool error and aborts the run (worker emits `error` frame, LocalWorkerPool handles). Both write tools honor it: `write-file.ts` L33-L45 and `edit-file.ts` L43-L65 both call `await claimer.claim(params.path)` before `fs.mkdir` / `fs.writeFile`. Cwd enforcement: `resolveInsideWorkdir()` (_fs.ts L46-L53) rejects any path that resolves outside `workdir`; used by `write-file`, `edit-file`, `read-file`, `list-files`, `search-files`. `ClaimLockFrame` + `ClaimDecisionFrame` exist in the schema. Integration `claim-lock-prehook.test.ts` (4/4 green): grants+writes+submits; rejects path-escape at tool layer; claim-lock RTT ≤50ms (measured 35.67ms in plan 03-04); denies + does-not-write + reports-error. |
| 6 | pi-sdk resume-fidelity spike decision: persist-tool-outputs | ✓ VERIFIED | `docs/spikes/pi-sdk-resume.md` (173 lines) documents the 5-scenario matrix with **measured** `lastRole=assistant` + `Agent.continue() throws 'Cannot continue from message role: assistant'` on scenarios 2-5 (cold-start scenario 1 is N/A). Raw observations captured in `.planning/phases/03-worker-execution-loop/spike-run-output.txt`. Minimal impl landed: `@runtime/resume` facade (`RESUME_STRATEGY = 'persist-tool-outputs'`, discriminated `ResumeOutcome`) + `ToolOutputStore` (in-memory + file-backed with atomic tmp+rename). Test surface: `test/integration/spike/pi-sdk-resume.test.ts` (6 tests: 5 scenarios + 1 facade smoke) all green; `test/unit/runtime/resume/tool-output-store.test.ts` (9 tests) all green. Phase 7 checklist explicitly written out in the spike doc §Phase 7 integration checklist. |

**Score:** 6/6 truths verified programmatically.

### Deferred Items

Items not yet met but explicitly addressed in later milestone phases per CONTEXT §Scope Fences and plan summaries.

| # | Item | Addressed In | Evidence |
|---|------|--------------|----------|
| 1 | `bypassOnce` map cannot grant a pre-approved retry because pi-sdk rotates `toolCall.id` | Phase 7 | `src/runtime/worker/index.ts` L146-L150 inline comment; plan 03-04 decisions #4. |
| 2 | Non-git destructive commands (rm -rf, dd, mkfs, find -delete, chmod -R 000, sudo *) are not blocked | Phase 7 | `docs/concerns/destructive-ops-non-git.md` + destructive-ops.ts L16-L24 scope comment. |
| 3 | `ToolOutputStore` keying on `{agentRunId, toolCallId}` for tool-retry-across-restart correctness | Phase 9 | spike doc §Known limitations bullet 3: "Phase 9 (crash recovery) will validate this keying." |
| 4 | Crash-recovery UX on top of the PID registry | Phase 9 | CONTEXT.md §Scope Fences: "this phase only persists PIDs"; plan 03-01 SUMMARY §Cross-Phase Hooks. |
| 5 | Inbox resolution UX / operator surface for `destructive_action` + `semantic_failure` rows | Phase 7 | CONTEXT §D + plan 03-04 decisions #3; migration 0005 header comment "Phase 7 extends this schema with more columns + query helpers". |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/runtime/worktree/pid-registry.ts` | WorkerPidRegistry with set/clear/list/isAlive | ✓ VERIFIED | 60 LOC; consumed by `PiSdkHarness` + `compose.ts`. |
| `src/runtime/worktree/index.ts` | GitWorktreeProvisioner + remove/prune/sweep | ✓ VERIFIED | 197 LOC; idempotent remove; stale-lock sweep conservative on read errors. |
| `src/runtime/ipc/frame-schema.ts` | typebox schema covering all frame variants | ✓ VERIFIED | 621 LOC; 19 frame variants; `CommitDoneFrame`/`HealthPing`/`HealthPong`/`ClaimLockFrame`/`ClaimDecisionFrame` all present. |
| `src/runtime/ipc/quarantine.ts` | bounded ring + fire-and-forget Store append | ✓ VERIFIED | 85 LOC; default capacity 64; `queueMicrotask` isolates SQLite from hot readline path. |
| `src/runtime/ipc/index.ts` | NdjsonStdio transports (parent + child) | ✓ VERIFIED | 181 LOC; symmetric validation; malformed lines quarantined not thrown. |
| `src/runtime/retry-policy.ts` | `decideRetry`, `buildRetryPolicyConfig`, DEFAULT_TRANSIENT_PATTERNS | ✓ VERIFIED | 124 LOC; pure; no imports from runtime/persistence/orchestrator. |
| `src/runtime/worker-pool.ts` | LocalWorkerPool with retry state + inbox escalation | ✓ VERIFIED | 440 LOC; `handleErrorFrame` branches retry/escalate on `decideRetry`. |
| `src/runtime/harness/index.ts` | PiSdkHarness + heartbeat loop + PID hooks | ✓ VERIFIED | 391 LOC; uses `child_process.fork` with `execArgv: ['--import', 'tsx']`; health-ping interval = `timeoutMs/2`. |
| `src/runtime/worker/index.ts` + `entry.ts` | WorkerRuntime + child-process entry with pi-sdk Agent | ✓ VERIFIED | 618 + 89 LOC; `beforeToolCall` hook wires `destructiveOpGuard` + fire-and-forget `requestApproval`; session save/load via `FileSessionStore`. |
| `src/agents/worker/destructive-ops.ts` | pure guard with 3 git patterns | ✓ VERIFIED | 81 LOC; scope fenced to git; returns `{block, reason}`. |
| `src/agents/worker/tools/commit-trailer.ts` | tokenize + inject + validate | ✓ VERIFIED | 136 LOC; idempotent; double-quote tokenizer handles `git commit -m "..."`. |
| `src/agents/worker/tools/run-command.ts` | shell-out with trailer rewrite + onCommitDone | ✓ VERIFIED | 281 LOC; detached process group (timeout safety); 1 MiB per-stream cap; post-commit inspection best-effort (swallows on git hiccup). |
| `src/agents/worker/path-lock.ts` + `tools/write-file.ts` + `tools/edit-file.ts` | claim-lock gate + cwd enforcement | ✓ VERIFIED | 27 + 47 + 77 LOC; both writes await `claimer.claim(params.path)` first; resolveInsideWorkdir throws on escape. |
| `src/runtime/resume/index.ts` | resume() facade + RESUME_STRATEGY | ✓ VERIFIED | 157 LOC; discriminated outcome; bail on missing tool outputs rather than synthesize. |
| `src/runtime/resume/tool-output-store.ts` | in-memory + file-backed stores | ✓ VERIFIED | 110 LOC; atomic tmp+rename; id sanitization; sync `get` (one-shot resume path). |
| `docs/spikes/pi-sdk-resume.md` | 5-scenario matrix + decision + Phase 7 checklist | ✓ VERIFIED | 173 lines; quotes live measurements; decision is "persist-tool-outputs". |
| `src/persistence/migrations/0003_agent_runs_worker_pid.sql` | nullable column + partial index | ✓ VERIFIED | 17 LOC; `ALTER TABLE agent_runs ADD COLUMN worker_pid INTEGER NULL`. |
| `src/persistence/migrations/0004_ipc_quarantine.sql` | ipc_quarantine table | ✓ VERIFIED | 27 LOC; ts/direction/agent_run_id/raw/error_message; two indexes. |
| `src/persistence/migrations/0005_inbox_items.sql` | inbox_items stub | ✓ VERIFIED | 28 LOC; kind=semantic_failure/destructive_action/...; partial index on unresolved. |
| `src/persistence/migrations/0006_agent_runs_last_commit_sha.sql` | last_commit_sha column | ✓ VERIFIED | 15 LOC; additive nullable; no index (PK lookup only). |
| `src/persistence/sqlite-store.ts` — new methods | set/clearWorkerPid, getLiveWorkerPids, appendQuarantinedFrame, appendInboxItem, setLastCommitSha | ✓ VERIFIED | Prepared statements L120-L195; implementations L308-L386. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `compose.ts` | `WorkerPidRegistry` | `createWorkerPidRegistry(store)` | ✓ WIRED | compose.ts L206 + threaded to `PiSdkHarness` constructor L213. |
| `compose.ts` | `LocalWorkerPool.retryDeps` | `buildRetryPolicyConfig(config)` + store | ✓ WIRED | compose.ts L230-L236. |
| `PiSdkHarness.forkWorker` | `worker/entry.ts` | `WORKER_ENTRY` resolved to `../worker/entry.ts` + `execArgv: ['--import', 'tsx']` | ✓ WIRED | harness/index.ts L61-L66, L218-L252. `GVC0_TASK_MODEL_PROVIDER` / `GVC0_TASK_MODEL_ID` env threaded from `config.models.taskWorker`. |
| `worker/entry.ts` | `health_ping` response | `transport.send({ type: 'health_pong', ts })` BEFORE the agent dispatch check | ✓ WIRED | entry.ts L37-L44. `GVC0_TEST_SKIP_HEALTH_PONG` test hook for timeout-path integration test. |
| `worker/index.ts` | `beforeToolCall` → `destructiveOpGuard` + `requestApproval` | pi-sdk `Agent({ beforeToolCall })` | ✓ WIRED | worker/index.ts L161-L202; fire-and-forget `queueMicrotask` around `requestApproval`. |
| `run-command` tool | `commit_done` frame | `onCommitDone` callback threaded via `buildWorkerToolset` | ✓ WIRED | worker/index.ts L122-L135 instantiates; run-command.ts L243 fires after validate-trailers; WorkerRuntime sends NDJSON frame. |
| `scheduler/events.ts` | `inbox_items` append on destructive | `message.payload.kind === 'destructive_action'` → `store.appendInboxItem` | ✓ WIRED | events.ts L162-L174. |
| `scheduler/events.ts` | `agent_runs.last_commit_sha` | `commit_done` → `setLastCommitSha` + emits `commit_trailer_missing` event on false | ✓ WIRED | events.ts L182-L193. |
| `LocalWorkerPool.handleErrorFrame` | inbox escalation | `decideRetry` escalate → `store.appendInboxItem({ kind: 'semantic_failure' })` + forward frame | ✓ WIRED | worker-pool.ts L389-L438. |
| `@runtime/resume` → consumers | facade export | `import { resume, RESUME_STRATEGY }` | ⚠️ PARTIAL (intentional) | No in-tree consumers yet — Phase 7 plan 07-03 is the consumer. spike doc §Phase 7 integration checklist pre-specifies the import call. Verifier flags this as expected given the SPIKE scope, not a gap. |

### Data-Flow Trace (Level 4)

Data-flow concerns for Phase 3 center on IPC frames, retry state, and DB rows. All three traced:

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|---------------------|--------|
| `LocalWorkerPool.retryState` Map | cached `task/dispatch/payload` | `dispatchTask()` caller (scheduler or test) | Yes — scheduler-loop + `worker-retry-commit` integration exercise it | ✓ FLOWING |
| `commit_done.sha` → `agent_runs.last_commit_sha` | parsed from `git rev-parse HEAD` | live git in worktree | Yes when a real commit runs; faux-provider integration test asserts 40-char SHA present | ✓ FLOWING (asserted in `worker-retry-commit.test.ts`) |
| `inbox_items.payload` | JSON-stringified `{description, affectedPaths}` / `{reason, error, attempts}` | `request_approval` frame / `decideRetry` escalate branch | Yes — `destructive-op-approval` test asserts row exists with correct kind; `worker-retry-commit` asserts `semantic_failure` row | ✓ FLOWING |
| `quarantine.recent()` ring | malformed line + schema error | readline `line` handler fallthrough | Yes — `worker NDJSON hardening — malformed-line survival` asserts ring populated + subsequent valid frames still delivered | ✓ FLOWING |
| `health_pong` lastPongTs | child NDJSON echo | worker `entry.ts` L37-L44 | Yes; timeout path synthesized when env var suppresses it | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase 3 unit tests | `npx vitest run test/unit/runtime/retry-policy.test.ts test/unit/ipc/quarantine.test.ts test/unit/ipc/frame-schema.test.ts test/unit/agents/commit-trailer.test.ts test/unit/agents/destructive-ops.test.ts test/unit/runtime/resume/tool-output-store.test.ts` | 6 files, 96 tests, 0 failures (16.86s) | ✓ PASS |
| Full unit suite (regression) | `npm run test:unit -- --run` | 68 files, 1520 tests, 0 failures (225s) | ✓ PASS |
| Phase 3 integration tests | `npx vitest run test/integration/worker-smoke.test.ts test/integration/worker-retry-commit.test.ts test/integration/worktree-pid-registry.test.ts test/integration/claim-lock-prehook.test.ts test/integration/destructive-op-approval.test.ts test/integration/spike/pi-sdk-resume.test.ts` | 6 files, 26 tests, 0 failures (32.39s) | ✓ PASS |
| Merge history intact | `git log --oneline --merges --all` | 009507e / 5c10eac / 04e9de2 / dfd6143 / 461887a all present; branches deleted as expected | ✓ PASS |
| Migration sequence intact | `ls src/persistence/migrations/` | 0001→0006 present, no gaps; 0003/0004/0005/0006 match plan allocations | ✓ PASS |
| Live pi-sdk resume against real provider | — | not runnable from verifier (no API credentials; spike doc explicitly flags) | ? SKIP → human_verification |
| Real worker forks through live provider to produce real commit | — | not runnable from verifier; faux-only path covered | ? SKIP → human_verification |

### Requirements Coverage

Requirements claimed by Phase 3 plans (per CONTEXT.md §Source): REQ-EXEC-01..05 + REQ-CONFIG-01 (use).

| Requirement | Description (abbrev.) | Status | Evidence |
|-------------|-----------------------|--------|----------|
| REQ-EXEC-01 | Worker lifecycle: isolated worktree, PID persisted, cleaned on exit | ✓ SATISFIED | `PiSdkHarness` + `WorkerPidRegistry` + migration 0003 + `worktree-pid-registry` integration tests. |
| REQ-EXEC-02 | Commit trailer + `commit_done` reverse frame + last_commit_sha persistence | ✓ SATISFIED | commit-trailer.ts + run-command.ts trailer rewrite/validate + CommitDoneFrame schema + scheduler/events.ts setLastCommitSha + migration 0006. |
| REQ-EXEC-03 | NDJSON IPC hardening — typebox, quarantine, heartbeat | ✓ SATISFIED | frame-schema.ts + quarantine.ts + Ndjson*Transport validation symmetry + harness heartbeat loop + migration 0004 + 25 unit tests + 3 integration tests. |
| REQ-EXEC-04 | Write pre-hook (claim_lock RTT, cwd enforcement, destructive-op gate, inbox escalation) | ✓ SATISFIED | path-lock.ts + \_fs.ts resolveInsideWorkdir + destructive-ops.ts guard + events.ts appendInboxItem(destructive_action) + worker-pool.ts appendInboxItem(semantic_failure) + migration 0005 + 3 integration tests (RTT measured 35.67ms vs 50ms budget). |
| REQ-EXEC-05 | Worker-pool side: retry-policy driving transient/semantic split | ✓ SATISFIED | retry-policy.ts pure `decideRetry` + LocalWorkerPool.handleErrorFrame wiring + buildRetryPolicyConfig in compose.ts + 12 unit tests + 3 integration tests. |
| REQ-CONFIG-01 | Config-driven model routing consumed here | ✓ SATISFIED | `PiSdkHarness` threads `config.models.taskWorker` via env → `worker/entry.ts` reads `GVC0_TASK_MODEL_PROVIDER` / `GVC0_TASK_MODEL_ID` with a hard-fail if missing (no silent default). `resolveModel` receives a `provider:model` spec from WorkerRuntimeConfig. |

No orphaned requirements detected — every REQ-EXEC-* claimed in CONTEXT maps to at least one plan's `requirements` field via the summaries.

### Anti-Patterns Found

Scan targeted at files modified in Phase 3 (per summaries' `key_files` sections).

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/runtime/worker/index.ts` | L150-L199 | TODO-adjacent "Phase 7 materializes a full approval-bypass protocol" | ℹ️ Info | Documented handover. Not a stub. The immediate block + inbox append path works today; only the retry-after-approval optimization is deferred. |
| `src/runtime/worktree/index.ts` | L86-L87 | `biome-ignore` on unused `_isAlive` param in `sweepStaleLocks` | ℹ️ Info | Deliberate forward-compat for Phase 9 per plan 03-01 decisions. |
| `src/runtime/resume/index.ts` | L153-L156 | Exports with no in-tree consumer yet | ℹ️ Info | Spike scope — Phase 7 checklist in the doc pre-specifies the import. Intentional orphan. |
| `src/runtime/worker/index.ts` | L194-L196 | `catch {}` on the fire-and-forget approval round-trip | ⚠️ Warning | Swallows errors from `requestApproval`. Acceptable for Phase 3 (the inbox row is the persistent surface and is appended by the orchestrator on frame arrival, not by the worker), but flagged for Phase 7 when richer UX lands. |
| `src/agents/worker/tools/run-command.ts` | L245-L248 | `catch {}` on post-commit trailer inspection | ℹ️ Info | Best-effort by design — a transient git hiccup must not stall the agent loop. The `commit_done` frame simply isn't emitted, which the orchestrator treats as "missing" — same safety envelope as a missing trailer. |

No **blocker** anti-patterns detected. All swallowed errors are at documented trust boundaries where the persistent side-effect is captured elsewhere (IPC frame or DB row).

### Human Verification Required

Two items need human + credentialed execution before the spike decision and the end-to-end worker can be called "shipped":

#### 1. Re-run pi-sdk resume spike against a live provider

**Test:** Point `test/integration/spike/pi-sdk-resume.test.ts` at a real Anthropic or OpenAI model (not pi-ai's faux provider). Re-run the 5-scenario matrix.
**Expected:** `lastRole=assistant` still appears on every resume-relevant path (scenarios 2-5); `Agent.continue()` still throws `"Cannot continue from message role: assistant"`. Decision stands.
**Why human:** The spike explicitly scopes its observations to pi-ai faux (docs/spikes/pi-sdk-resume.md §Known limitations bullet 1). A live provider may surface different streaming timing / tool-call packaging / token accounting. Verifier cannot run this (no API credentials).

#### 2. End-to-end worker → live provider → real commit SHA round-trip

**Test:** Wire up the orchestrator with `config.models.taskWorker` pointed at a live provider. Dispatch a single task whose instructions end in `git commit -m "feat: hello"`. Observe:
  - `agent_runs.worker_pid` populated during the run, cleared on exit.
  - Commit produced carries both `gvc0-task-id=<task>` and `gvc0-run-id=<run>` trailers (verify via `git log -1 --format=%B` or `git interpret-trailers --parse`).
  - `agent_runs.last_commit_sha` matches the actual commit SHA.
  - No `commit_trailer_missing` event in the event log.
  - No `ipc_quarantine` rows unless intentionally induced.

**Expected:** Every observation true; single-task E2E closes SC #1 on a live process boundary.
**Why human:** All integration coverage uses either in-process `InProcessHarness` or the `PiSdkHarness` against a faux stream. No CI job exercises the real `child_process.fork → live provider → git commit` path. Verifier cannot simulate provider network calls.

### Gaps Summary

No blocking gaps. All 6 success criteria have code + tests + integration verification. Two items require human attention before declaring Phase 3 "live-tested":

1. **Live-provider spike re-run** — documented as a known limitation in the spike doc itself; moving Phase 7 forward on the faux-provider evidence is the accepted risk per plan 03-05 decision #1.
2. **Live-provider E2E** — the pieces are individually verified but never run together against a real provider in one task. This is arguably Phase 4 or Phase 8 scope (a real smoke test needs a scheduler + orchestrator + UI to trigger), but recording it here protects future maintainers from assuming the pieces-sum-to-whole because each piece has its own test.

The five deferred items are correctly scoped for Phase 7 / Phase 9 and don't reduce Phase 3's score — they're either explicit scope fences (CONTEXT §Scope Fences) or documented handovers (comments in source + concerns doc).

### Observations on Goal Achievement

**What the phase shipped:**
- An end-to-end worker execution loop where a task dispatched via `LocalWorkerPool` forks a pi-sdk `Agent` child in an isolated worktree, communicates over schema-validated NDJSON with heartbeat failure detection, runs under a write pre-hook that enforces cwd-sandboxing and explicit path-lock approvals, emits a commit with gvc0 trailers that the orchestrator attributes back to the task/run, retries transient failures in-pool and escalates semantic ones to a durable inbox row, and can be resumed across worker restarts via a persist-tool-outputs fallback that the 5-scenario spike has proven necessary.
- Six migrations (0001-0006) with 0003-0006 being Phase 3's contribution; a widened Store port with six new methods; a typebox frame schema supporting 19 variant types; integration harness scaffolding for both in-process faux-provider tests and real-fork spike tests.
- 1520 unit tests passing, 26 Phase-3-scoped integration tests passing, no regressions in the broader suite.

**Test coverage assessment:**
- **Excellent for pure logic:** retry decision, trailer parsing, destructive-op matching, path-lock claims, resume splice, quarantine ring, frame schema — all have targeted unit suites.
- **Good for wiring:** compose.ts is asserted by `test/unit/compose.test.ts`; scheduler/events.ts inbox-append path is covered by `destructive-op-approval.test.ts`.
- **Layered for process boundaries:** faux-provider + in-process harness proves the IPC contract, the PID-registry lifecycle, and the error-frame → retry → inbox path without actually forking a real child.
- **Gap (flagged to human):** no integration test actually runs the real `child_process.fork` → live provider → git commit path in one test. Each layer tests its interface; the full stack against a real process boundary has only been exercised manually during development.

**Was the goal achieved?**
Yes, modulo the live-provider gate. The phase delivered a worker loop that is *structurally* end-to-end and correct: every claimed IPC frame type round-trips under schema validation, every claimed DB migration applies, every claimed retry/escalation path is wired and tested, and the spike produced a grounded, documented decision with a regression harness. The process-per-task + isolated-worktree + clean-recoverable-PID-registry invariants all hold under the integration tests.

The remaining question — "does this work against a real provider?" — is not a Phase 3 defect but a Phase 8 (TUI smoke) or Phase 9 (crash recovery UX) concern that will naturally exercise the live path. Flagging it explicitly here so the developer doesn't assume faux coverage = production readiness.

---

_Verified: 2026-04-23T23:58:00Z_
_Verifier: Claude (gsd-verifier, Opus 4.7)_
