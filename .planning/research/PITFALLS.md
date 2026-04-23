# Pitfalls Research

**Domain:** Local autonomous coding orchestrator (DAG-first, pi-sdk, parallel pi-sdk Agent processes in git worktrees, merge train, multi-surface TUI)
**Researched:** 2026-04-23
**Confidence:** HIGH (existing `docs/concerns/` catalog provides direct first-hand evidence; comparator pitfalls well understood) / MEDIUM (for pi-sdk-specific behavior that needs live verification)

> Note: research-agent attempts timed out; this report draws on the existing in-tree concerns catalog (`docs/concerns/`) + comparator experience. Where concerns are already cataloged in the repo, the entry cross-references that doc and adds detail specific to gvc0's v1 decisions.

## Critical Pitfalls

### Pitfall 1: Stale `.git/index.lock` / Orphan Worktrees After Crash

**What goes wrong:**
Orchestrator crashes while a worker is mid-commit or mid-rebase. `.git/index.lock` or `.git/worktrees/<name>/index.lock` remains on disk. Next boot's workers hang or fail immediately; subsequent task dispatches pile up, never making progress.

**Why it happens:**
`git` locks aggressively; process-crash doesn't always release. `simple-git` is thin and does not auto-recover lock state.

**How to avoid:**
- On orchestrator boot, sweep `.git/worktrees/*/index.lock` and `.git/index.lock`, check staleness (older than any known live PID), and clean.
- Track each worktree's owning worker PID in SQLite; if no live PID claims it on boot, route to inbox as "orphan worktree" item.
- `git worktree prune` only runs when no tasks are executing against that worktree.

**Warning signs:**
Boot-time repeated IPC timeouts from workers. `git status` from a worktree hangs. `.git/worktrees/<name>` directory exists but SQLite has no active task referencing it.

**Phase to address:**
Phase 3 (Worker Execution Loop — worktree manager) + Phase 9 (Crash Recovery UX).

---

### Pitfall 2: Merge-Train Re-Entry Starvation / Infinite Loop

**What goes wrong:**
A feature branch repeatedly fails verification after rebase. Re-entry count grows; feature cycles forever, burning tokens and blocking nothing but quietly rotting. Already cataloged: `docs/concerns/merge-train-reentry-starvation.md`, `docs/concerns/merge-train-reentry-cap.md`.

**Why it happens:**
Verification oracle (agent review) returns nondeterministic pass/fail due to prompt drift or model stochasticity; or an underlying regression persists because repair loop fixes symptoms but not cause.

**How to avoid:**
- Configurable re-entry cap (REQ-MERGE-03, default 10). On cap, park feature in inbox with full re-entry diagnostic (what changed per rebase, what verify complained about each time).
- Verify agent prompt should be deterministic enough to flake-rate-audit: run the same review 5× against a known-good branch in tests; assert ≥90% consistency.
- Track re-entry reasons; if >N re-entries all cite the same verify failure category, escalate to inbox earlier than cap.

**Warning signs:**
`mergeTrainReentryCount` > 3 on a single feature. Repair commits per feature > 5 with no corresponding user input.

**Phase to address:**
Phase 6 (Merge Train).

---

### Pitfall 3: Silent Token Burn via Retry Loops

**What goes wrong:**
Semantic failures get misclassified as transient; agent retries silently with same prompt; token bill grows without user awareness. Also: `docs/concerns/summarize-retry-loop.md`, `docs/concerns/worker-runaway.md`.

**Why it happens:**
"Transient vs semantic" is a heuristic; boundary cases (rate limits that look transient but persist, ambiguous errors) get re-tried forever without a ceiling.

**How to avoid:**
- Strict per-task retry cap (3 transient retries by default, configurable).
- Pass through to inbox after cap, regardless of transient/semantic classification.
- Emit a `worker_runaway` warning when any single task has burned > threshold tokens without making progress (no new commit, no new tool-call category).
- Surface usage rollups per task/feature in the TUI so cost anomalies are visible live.

**Warning signs:**
Same error message 3× from the same task. Per-task token usage above historical median × 3. Zero commits over N minutes of agent activity.

**Phase to address:**
Phase 3 (retry policy) + Phase 11 (diagnostic surfacing).

---

### Pitfall 4: Planner Drift — Top-Level Planner Reshapes Features Under an Active Feature-Level Planner

**What goes wrong:**
User accepts a top-level planner proposal that renames / splits / merges a feature whose feature-level planner is actively generating tasks. The in-flight task graph references an old `FeatureId` or an old feature shape; tasks get created that don't match the new plan.

**Why it happens:**
Two-planner model without explicit collision rule; events arrive out of order.

**How to avoid:**
Apply REQ-PLAN-07: proposal view flags the in-flight feature-level planner; accepting cancels it. Feature-level planner re-runs on the post-edit shape. Enforce at the mutation layer: `editFeature`/`splitFeature`/`mergeFeatures` must check for and cancel active feature-phase agents on the affected features before applying.

**Warning signs:**
Tasks created on a feature with `workControl=planning` and a *different* stale planner session recorded.

**Phase to address:**
Phase 7 (Top-Level Planner) — must land with the cancel-on-edit logic, not after.

---

### Pitfall 5: Agent "Hallucinates Progress" Without Real Commits

**What goes wrong:**
Task agent runs for 10 minutes, reports "done!", but produced no commit. Worker marks task done; feature proceeds; later stages confuse an empty-commit feature with a real one.

**Why it happens:**
Agents sometimes stop early with optimistic self-report. Without a ground-truth check, orchestrator trusts the self-report.

**How to avoid:**
- Task completion requires a detectable commit on the feature branch with the worker's signature (commit trailer with task ID).
- If agent reports done but no new commit exists, reject completion; route to inbox.
- Feature-phase "verify" agent reads the diff — if the diff doesn't address the feature goal, fail verification.

**Warning signs:**
Task marked done with no commit on the feature branch. Commit exists but has no gvc0 trailer. Feature branch has fewer commits than completed tasks.

**Phase to address:**
Phase 3 (worker completion protocol) + Phase 5 (feature verify catches semantic drift).

---

### Pitfall 6: SQLite WAL Checkpoint Stalls / Blocking Writes

**What goes wrong:**
Under sustained high-frequency writes (every task progress update, every worker message event), WAL file grows; checkpoint thrash or long-held writer lock stalls synchronous write calls from the event queue; the whole orchestrator freezes.

**Why it happens:**
`better-sqlite3` is synchronous; a slow checkpoint blocks the event loop. Default auto-checkpoint interval is tuned for general use, not per-event-queue usage.

**How to avoid:**
- Batch non-critical updates (e.g., transcript progress) into periodic flushes, not per-event.
- Tune `PRAGMA wal_autocheckpoint` for the expected write rate.
- Ensure WAL file is on the same filesystem as the DB (no cross-mount fsync pain).
- Run periodic `PRAGMA wal_checkpoint(PASSIVE)` from a low-priority maintenance task.

**Warning signs:**
Event queue processing time P95 > 100ms. WAL file > 10x DB size. Occasional multi-second pauses in TUI.

**Phase to address:**
Phase 2 (Persistence) — configure WAL tuning up front + define which messages are batched vs. immediate.

---

### Pitfall 7: NDJSON IPC Partial Message / Malformed Crash

**What goes wrong:**
A worker writes a partial JSON line (e.g., crashes mid-write) or emits invalid JSON; orchestrator parser crashes or silently drops subsequent messages; the worker is orphaned.

**Why it happens:**
Naive stdio parsing assumes well-formed lines and no partial writes across chunks.

**How to avoid:**
- Line-buffer reader with explicit newline delimiter + max-line-length guard; malformed lines go to a quarantine log, parser survives.
- Worker emits messages atomically: build full line in memory, write with single `process.stdout.write(line + '\n')`.
- Schema-validate every incoming message via `@sinclair/typebox`; invalid schema → quarantine + warning, not crash.
- Orchestrator detects worker silence > N sec → health-check (send ping); no response → declare crashed, route to recovery.

**Warning signs:**
Gaps in sequence numbers on worker messages. Parser warning logs. Workers stuck in "running" without progress.

**Phase to address:**
Phase 3 (IPC framing + worker protocol).

---

### Pitfall 8: Two-Tier Pause Race — Timer Fires While User Is Mid-Answer

**What goes wrong:**
Worker in inbox pause; user starts typing answer; pause-timer expires mid-type; checkpoint written, process killed. User submits → orchestrator spawns a fresh worker, replays transcript, delivers answer — but user doesn't know they're now talking to a different process (and latency spiked).

**Why it happens:**
Separate timer logic unaware of user activity state.

**How to avoid:**
- Timer starts on first inbox display; resets on any input activity on that inbox item (including focus).
- Answering an inbox item always first cancels the timer, *then* delivers the answer.
- TUI visually indicates "pause timer" countdown on each paused task so the user can see they're close to checkpoint.

**Warning signs:**
User reports "my answer took forever to go through." Increased checkpoint rate just after user session start.

**Phase to address:**
Phase 7 (Inbox + pause-resume interaction).

---

### Pitfall 9: pi-sdk Agent Resume Fidelity Uncertainty

**What goes wrong:**
After release-to-checkpoint and later re-spawn, the replayed agent reaches a different internal state than the original (model version drift, sampling variation, tool-call order changes). Agent responds inconsistently to the user's answer; or the resumed tool calls produce different file output than the pre-pause ones.

**Why it happens:**
LLM agents are non-deterministic; replay semantics depend on what pi-sdk persists and how transcripts are compiled.

**How to avoid:**
- Spike pi-sdk resume fidelity *before* committing to two-tier pause (REQ-INBOX-02/03 are spike-gated).
- If fidelity is insufficient: persist tool-call outputs alongside the transcript so replay short-circuits to stored outputs for pre-pause calls.
- Lock the model version for a session; warn the user if pi-sdk upgrades mid-session in a way that would change replay behavior.
- Include in the replay-start prompt: "you are resuming; N tool calls have already happened with these observed outputs: [...]".

**Warning signs:**
Diffs between pre-pause and post-resume task output. User reports "it forgot what I said" after resume.

**Phase to address:**
Spike in Phase 3; Phase 7 only implements the tier that the spike validates.

---

### Pitfall 10: Agent Writes Outside the Worktree / Runs Destructive Commands

**What goes wrong:**
Task agent executes `rm -rf /`, writes outside its worktree (touches `main`'s working tree, deletes user config), runs `git push --force`, installs malicious deps, or reads/writes secrets outside the repo.

**Why it happens:**
Agents with shell access and broad tool permissions; no sandboxing by default.

**How to avoid:**
- Worker sets `cwd` to the task worktree and passes allow-listed environment; shell tool usage is always scoped to the worktree path (pre-hook validates).
- Destructive git operations (`push --force`, `branch -D`, `reset --hard origin`) require inbox approval (REQ-TUI-02 / REQ-INBOX-01).
- Filesystem pre-hook rejects writes outside the worktree directory.
- `npm install` goes through the task worktree's isolated dependency set; global `npm install -g` is denied.
- No environment variable leak: only task-relevant env passed to the worker process.

**Warning signs:**
Pre-hook rejections logged. Task attempted `sudo` / `chmod`. Task wrote to a path outside the worktree.

**Phase to address:**
Phase 3 (worker pre-hook + scoped env) — this is load-bearing, not polish.

---

### Pitfall 11: TUI Flicker / Event-Loop Starvation with Large DAGs or Streaming Transcripts

**What goes wrong:**
Many concurrently updating task transcripts + large feature DAG refreshing every tick causes terminal flicker, input lag, missed keypresses.

**Why it happens:**
Naive re-render on every event; unbounded transcript scrollback.

**How to avoid:**
- Render at a capped frequency (e.g., 15 Hz).
- Per-surface change detection — don't redraw what didn't change.
- Transcript surface only renders the focused task stream at full rate; background task streams update a lightweight "activity" indicator only.
- Virtualize long transcript scrollback.

**Warning signs:**
Key presses missed. Observable flicker in terminal. Input lag > 200ms.

**Phase to address:**
Phase 8 (TUI surfaces — performance budget per surface).

---

### Pitfall 12: State-Axis Divergence (work/collab/run out of sync)

**What goes wrong:**
Task `run` reaches `await_response` but `work control` thinks the feature is still `executing`; merge train reads stale `collab=merge_queued` and tries to integrate a feature whose tasks are blocked.

**Why it happens:**
Updates to the three axes happen in separate mutations; without FSM guards, composite invariants silently break.

**How to avoid:**
- FSM guards in `core/fsm/` must validate composite states (work × collab × run) — not just per-axis transitions.
- After every tick, assert composite invariants against the graph; warn on violation.
- Derived statuses (e.g., `partially_failed`, `blocked`) always recompute — never cache.
- `test_graph_invariants.md` and `test_graph_contracts.md` already scope this; ensure implementation exercises the composite guards.

**Warning signs:**
Warnings fire for "impossible" state combos. Merge train attempts to integrate a feature with active await_response runs.

**Phase to address:**
Phase 1 (core FSM) and Phase 4 (scheduler + invariants).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Inline graph mutations outside the event queue | Faster to write in single-threaded-looking code | Re-introduces races; the entire "serial core" design goal dissolves | **Never** |
| Per-task token limits with no override path | Trivial to ship | Power users get blocked on legit long tasks; requires restart to adjust | Only if TUI config editor (REQ-TUI-04) lets them raise it live |
| `@ts-ignore` on FSM guard types | Unblocks a refactor | Silently loses the compile-time guarantee on state transitions | Only with a linked TODO + phase to remove by |
| Log everything to stderr unstructured | Easy | Hides NDJSON parser errors; conflates worker log and protocol | Only in dev; production must use structured logs |
| Direct `git` calls from orchestrator (bypassing worktree manager) | Shorter diff | Worktree state becomes un-trackable | **Never in v1** |
| Hand-rolled JSON parse of IPC messages | Avoids schema library | Schema drift crashes production; no error surface | **Never** — always schema-validate |
| TUI reads graph state directly vs. via derived view-models | Fewer abstractions | Divergence bugs; hard to snapshot render state | Only during debug/dev |
| Skipping e2e tests because `@microsoft/tui-test` is 0.0.4 | Faster iteration | Regressions in TUI reach users | Acceptable through Phase 1–8; add before Phase 12 |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `@mariozechner/pi-agent-core` (pi-sdk) | Spawning `Agent` instances outside the worker pool | All agent work goes through the scheduler + worker pool; feature-phase agents via `SchedulableUnit`-unified dispatch |
| pi-sdk `fauxModel` | Writing integration tests that assume today's prompt string | Tests should assert on tool-call sequences + graph mutations, not on prompt wording |
| `simple-git` | Running `rebase` without checking worktree cleanliness | Worktree manager always stashes + checks clean state before rebase; fail fast if dirty |
| `better-sqlite3` | Running long-running read queries from TUI rendering path | TUI reads derived view-models; heavy queries are pre-computed and cached per-tick |
| `@microsoft/tui-test` | Relying on exact layout pixel positions | Test observable behavior (keystroke → visible state change), not layout geometry |
| `git worktree add` | Re-using a path that's already a worktree | Generate unique worktree names including task ID + short random suffix; assert path doesn't exist before add |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Rebuild combined graph on every mutation | Scheduler tick latency grows as graph grows | Incremental invalidation (only affected subgraph recomputes) | > ~200 total nodes |
| Per-event SQLite write | Event queue P95 > 100ms; UI lag | Batch non-critical writes (transcript chunks); only FSM transitions write immediately | > 50 events/sec sustained |
| TUI render at full rate for all surfaces | Flicker, input lag | Rate-cap 15 Hz; change-detect per surface | > 5 concurrent task streams |
| Unbounded transcript scrollback | Memory growth; slow scroll | Virtualize; persist to SQLite; render window | Long-running sessions (hours) |
| Re-parse worker messages through multiple layers | CPU spikes under load | Parse once; pass structured message through pipeline | > 10 concurrent workers |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Passing full env to worker processes | Secrets leak via tool calls (e.g., `echo $API_KEY`) | Allow-list env keys; expand on demand via inbox approval |
| Letting agents run arbitrary shell outside worktree cwd | System damage, secret exfil | Worker `spawn()` cwd = worktree; pre-hook rejects writes outside worktree |
| Persisting API keys in SQLite | Disk exposure | Keys only in env / OS keychain; never written to DB |
| `git push --force` without approval | Remote history loss | Route all remote-mutating git ops through inbox approval |
| Installing agent-chosen npm packages globally | Supply-chain poisoning | `npm install` scoped to worktree; never `-g`; optionally post-install audit |
| Logging user prompts verbatim including pasted secrets | Secret recorded in transcript → audit log | Redact patterns (API-key-like strings) at the logging layer |
| Unchecked HTTP requests from agents | SSRF / data exfil | Tool allow-list; note: current architecture doesn't intercept HTTP — documented limitation |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent auto-resume without showing what recovered | User confused about "where things are"; mistrust | Post a "recovery summary" inbox item on boot: N tasks resumed, M orphan worktrees, K re-entry-capped features |
| Inbox items without enough context to decide | User has to re-read the whole task transcript to answer a question | Inbox entry snapshots relevant context (file, last messages, what the agent is about to do) |
| Cancel-task without worktree clarity | User unsure whether cancelling leaves artifacts behind | Three cancel levers (REQ-TUI-05) with clear labels: "preserve worktree / clean worktree / abandon branch" |
| Config changes taking effect after restart | Power users can't tune live | Watch config file; apply hot-reloadable keys immediately (model, worker cap, pause timeout); flag restart-required ones |
| No way to re-read a prior planner proposal | "What did I just accept?" | Per-feature audit log viewable from TUI (REQ-PLAN-06) |
| TUI switches focus on new inbox items mid-answer | User loses typing context | Focus changes require explicit nav; inbox updates are peripheral indicators |
| Model name mentioned without context of which role | "Which agent used what model?" | Always label: "top-planner: claude-opus-4-7" not just "claude-opus-4-7" |

## "Looks Done But Isn't" Checklist

- [ ] **Crash recovery:** Does it survive `kill -9` mid-worker-write? Mid-rebase? Mid-merge? Verify with fault-injection tests; if only clean-shutdown works, it's not done.
- [ ] **Two-tier pause:** Does the replayed worker actually answer the user's question correctly? Spike before calling this done.
- [ ] **Cancel-task-clean:** Does it actually remove the worktree directory AND reset the feature branch? Or does it leave orphan state?
- [ ] **Merge train re-entry cap:** Does parking actually surface an inbox item with the diagnostic? Or does it silently set a flag?
- [ ] **Verify = agent review:** Is the verifier actually a pi-sdk agent with a real review prompt? Or is it a stub that always passes?
- [ ] **Inbox "things waiting on you":** Does it cover all six sources (agent asks, conflicts, approvals, auth expiry, orphan cleanup, re-entry parkings)? Or just agent asks?
- [ ] **Manual edit always wins:** If user edits a feature while planner is running, does the in-flight planner actually get cancelled? Or does it land its mutations anyway?
- [ ] **Config editing in TUI:** Does changing the model actually take effect for *next* tasks without restart?
- [ ] **Usage tracking:** Is per-task token usage actually displayed? Or is the data collected but never shown?
- [ ] **Feature deps = "wait for merge to main":** Is this actually enforced by the scheduler? Or can a downstream feature dispatch because the upstream's branch exists but hasn't merged?
- [ ] **Auto-resume orphan worktrees:** Do we detect them, clean them, and notify? Or do they accumulate silently?
- [ ] **`main` never red invariant:** Is there an integration test that proves a verification-failing feature does NOT advance `main`?
- [ ] **Planner prompt audit log:** Can the user read past prompts per feature? Or is it write-only?
- [ ] **Process-per-task resource isolation:** Can one runaway worker starve others of CPU/memory? Test under stress.
- [ ] **Composite state invariants:** Do we assert that (work × collab × run) combinations are valid, or only per-axis?

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Stale `.git/index.lock` | LOW | Boot-time sweep; orphan-worktree inbox item; user-approved cleanup |
| Merge train stuck in re-entry loop | MEDIUM | Inbox item on cap; user chooses: force-merge-with-override, abort feature, manual repair commit |
| SQLite WAL runaway | MEDIUM | Pause event queue; run `PRAGMA wal_checkpoint(RESTART)`; resume. Backup DB before any manual repair. |
| Worker runaway (silent token burn) | MEDIUM | Automatic kill on threshold; inbox item with diagnostic + "retry / skip / abort feature" |
| Planner drift / mid-execution reshape collision | LOW | REQ-PLAN-07 makes this visible at proposal time; accept cancels feature-level planner; no recovery needed |
| Composite state divergence | HIGH | Invariant check warning; dump graph + run state to an incident file; user-triaged via diagnostic CLI |
| Agent hallucinates progress | LOW | Worker completion requires a real commit with trailer; fails fast |
| TUI flicker | LOW | Rate-cap render + per-surface change detection |
| Pi-sdk resume infidelity | HIGH | Fallback to persist-tool-outputs replay; worst case: disable two-tier pause and require user to answer within the hot window |
| Agent runs destructive command | HIGH | Pre-hook should prevent; if it slips through, Git history + worktree snapshot lets us recover. User approval gate on `push --force` is the main guard. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Stale lock / orphan worktree | Phase 3 (worktree manager) + Phase 9 (recovery UX) | Fault injection test: kill orchestrator during worker commit; confirm boot cleans |
| Merge-train re-entry starvation | Phase 6 (merge train) | Unit test: simulate 12 consecutive verify failures; assert parks to inbox at cap |
| Silent token burn | Phase 3 (retry policy) | Integration test: task repeatedly errors with same message; asserts inbox entry after 3 |
| Planner drift | Phase 7 (top-level planner) | Test: top-level edit during active feature-level planner → feature-level cancelled |
| Agent hallucinates progress | Phase 3 + Phase 5 | Test: task reports done without new commit → worker rejects completion |
| SQLite WAL stall | Phase 2 | Load test: 100 events/sec for 10 min; assert P95 event queue < 100ms |
| NDJSON parser crash | Phase 3 (IPC framing) | Fuzz test: malformed lines don't crash parser; gaps detected |
| Two-tier pause timer race | Phase 7 (inbox UX) | Test: user typing resets timer; answer always delivered |
| pi-sdk resume infidelity | Spike before Phase 7 | Live comparison: 10 task runs compared pre-pause / post-resume |
| Destructive agent command | Phase 3 (pre-hook) | Test: agent attempting write outside worktree → pre-hook rejects |
| TUI flicker | Phase 8 | Perf test: 10 concurrent task streams; observable flicker absent at 15 Hz |
| State-axis divergence | Phase 1 (FSM) + Phase 4 (scheduler) | Invariant checker test: every tick asserts composite state valid |

## Cross-References to In-Tree Concerns

Already catalogued concerns (keep as source of truth and cross-reference during phase planning):

- `docs/concerns/merge-train-reentry-cap.md` — Pitfall 2
- `docs/concerns/merge-train-reentry-starvation.md` — Pitfall 2
- `docs/concerns/worker-runaway.md` — Pitfall 3
- `docs/concerns/summarize-retry-loop.md` — Pitfall 3 variant
- `docs/concerns/planner-write-reservation-accuracy.md` — adjacent to Pitfall 4 (planner correctness)
- `docs/concerns/verification-and-repair-churn.md` — adjacent to Pitfall 2 and 5 (verification fidelity)
- `docs/optimization-candidates/push-based-conflict-detection.md` — performance trap mitigation (reservation detection latency)
- `docs/optimization-candidates/abort-in-flight-scheduler-tick.md` — related to recovery latency

Existing specs that exercise these pitfalls (keep as executable contracts):

- `specs/test_crash_recovery.md`
- `specs/test_stuck_detection_replan.md`
- `specs/test_graph_invariants.md`
- `specs/test_merge_train_conflict_handling.md`
- `specs/test_cross_feature_overlap_runtime.md`
- `specs/test_same_feature_overlap_detection.md`
- `specs/test_scheduler_frontier_priority.md`
- `specs/test_conflict_steering.md`

## Sources

- `/home/alpine/vcode0/docs/concerns/` — authoritative list of in-tree concerns (cross-referenced above)
- `/home/alpine/vcode0/docs/optimization-candidates/` — related performance mitigations
- `/home/alpine/vcode0/specs/` — executable pitfall contracts
- `/home/alpine/vcode0/docs/operations/conflict-coordination.md`
- `/home/alpine/vcode0/docs/operations/verification-and-recovery.md`
- `/home/alpine/vcode0/docs/operations/warnings.md`
- `/home/alpine/vcode0/.planning/PROJECT.md` — v1 decisions that resolve several in-tree concerns
- General experience: autonomous agent orchestration, git worktree managers, merge queues

---
*Pitfalls research for: DAG-first autonomous coding orchestrator*
*Researched: 2026-04-23*
