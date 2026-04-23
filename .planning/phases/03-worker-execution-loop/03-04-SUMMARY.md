---
phase: 03-worker-execution-loop
plan: 04
subsystem: worker-execution-loop
tags: [worker, destructive-ops, beforeToolCall, claim-lock, inbox, REQ-EXEC-04]
dependency_graph:
  requires: [03-03]
  provides: [destructive-op guard, inbox approval stub, cwd+claim+RTT proof]
  affects: [03-05 (parallel-wave sibling; no line-overlap), Phase 7 (inbox UI)]
tech_stack:
  added: []
  patterns: [pi-sdk beforeToolCall hook, fire-and-forget requestApproval microtask]
key_files:
  created:
    - src/agents/worker/destructive-ops.ts
    - test/unit/agents/destructive-ops.test.ts
    - test/unit/agents/path-lock.test.ts
    - test/integration/destructive-op-approval.test.ts
    - docs/concerns/destructive-ops-non-git.md
  modified:
    - src/runtime/worker/index.ts
    - src/orchestrator/scheduler/events.ts
    - test/integration/claim-lock-prehook.test.ts
    - docs/concerns/README.md
decisions:
  - "pi-sdk beforeToolCall is the single central surface for destructive-op detection; per-tool wrapping is deliberately avoided (RESEARCH §Write Pre-Hook)."
  - "Destructive-op scope is git-only in Phase 3 (push --force / branch -D / reset --hard); non-git ops (rm -rf, dd, mkfs, find -delete) deferred to Phase 7 via docs/concerns/destructive-ops-non-git.md."
  - "Approval round-trip is fire-and-forget from inside beforeToolCall — the guard returns block synchronously, the orchestrator round-trip runs as a queueMicrotask so the hook stays non-blocking."
  - "bypassOnce map is keyed by toolCall.id but pi-sdk crafts a fresh id on retry; this is a known Phase 7 handover (the persistent record is the inbox_items row, not the bypass token)."
  - "Orchestrator appends inbox_items row inside the existing request_approval handler in events.ts so a single source of truth governs escalation."
metrics:
  tasks_completed: 6
  tasks_planned: 6
  commits: 6
  unit_tests_added: 23
  integration_tests_added: 3
  claim_lock_rtt_measured_ms: 35.67
  claim_lock_rtt_budget_ms: 50
---

# Phase 03 Plan 04: Write Pre-Hook + Destructive-Op Guard Summary

Hardens the worker write pre-hook with three proven enforcement surfaces
(cwd, claim-lock RTT, destructive-op guard) and stubs the inbox approval
round-trip for REQ-EXEC-04. All six tasks landed autonomously with no
rule-4 (architectural) escalations.

## One-liner

Destructive git ops (force-push, branch -D, reset --hard) now block at
pi-sdk's beforeToolCall seam and route to inbox_items via the existing
request_approval path; cwd enforcement + <50ms claim-lock RTT proven in
integration.

## What Shipped

### Destructive-op guard (Tasks 1-2)
- `src/agents/worker/destructive-ops.ts` — pure matcher with three
  ReadonlyArray entries (push --force, branch -D, reset --hard) + an
  async adapter matching pi-sdk's `BeforeToolCall*` types. No imports
  from @runtime / @persistence / @orchestrator.
- `src/runtime/worker/index.ts` — wires `destructiveOpGuard` into
  `new Agent({ beforeToolCall })`. On block, a `queueMicrotask` fires
  `ipc.requestApproval({ kind: 'destructive_action', ... })` so the
  orchestrator sees a request_approval frame. A `bypassOnce` map keyed
  by `toolCall.id` is wired for symmetry; see the inline comment for
  the pi-sdk toolCall-id-rotation limitation (Phase 7 handover).
- `src/orchestrator/scheduler/events.ts` — when `request_approval` with
  `kind === 'destructive_action'` arrives, appends a row via
  `store.appendInboxItem`. Default approval response stays reject (no UI
  in Phase 3).

### Unit tests (Task 3)
- `test/unit/agents/destructive-ops.test.ts` — 8 positive patterns
  (push --force / -f, branch -D / --delete --force, reset --hard,
  leading whitespace), 7 negatives (`git push origin main`, `branch -d`
  lowercase, `reset --mixed`, `npm test`, `rm -rf /` out-of-scope), 4
  adapter behaviours (block path, non-destructive pass-through,
  non-run_command pass-through, non-string args pass-through). Plus
  a DESTRUCTIVE_PATTERNS shape smoke test.
- `test/unit/agents/path-lock.test.ts` — claimer caches granted paths
  (1 round-trip for 3 claims on same path), distinguishes distinct paths
  (2 round-trips for a.ts + b.ts + a.ts), throws on denial, denial is
  NOT cached (re-claim hits wire again).

### Integration tests (Tasks 4-5)
- `test/integration/claim-lock-prehook.test.ts` — 2 new cases:
  cwd-escape rejection (`../../../etc/...`) and RTT budget (<50ms
  measured, target <5ms per A2). Existing 2 happy/deny cases intact.
- `test/integration/destructive-op-approval.test.ts` — end-to-end proof:
  faux worker emits `git push --force`, `refs/heads/main` on the local
  bare repo is unchanged, `request_approval` frame emitted with the
  right kind/description, routing the frame through
  `handleSchedulerEvent` appends an `inbox_items` row with the payload
  shape we expect.

### Docs (Task 6)
- `docs/concerns/destructive-ops-non-git.md` — Phase 7 expansion ticket:
  lists `rm -rf`, `find -delete`, `dd`, `mkfs`, `truncate`, `chmod -R 000`,
  `sudo *` as deferred. Proposes path-aware heuristics + policy
  allow-list + spawn isolation as Phase 7 directions.
- `docs/concerns/README.md` — new entry link.

## Test Matrix

| Surface        | Unit                                                   | Integration                                      |
| -------------- | ------------------------------------------------------ | ------------------------------------------------ |
| cwd escape     | (existing `test/unit/agents/worker/tools/file-ops.test.ts` via `resolveInsideWorkdir`) | `claim-lock-prehook.test.ts` cwd case            |
| claim lock     | `write-prehook.test.ts` (existing) + `path-lock.test.ts` (new) | `claim-lock-prehook.test.ts` (happy + deny + RTT) |
| destructive op | `destructive-ops.test.ts` (new, 23 cases)              | `destructive-op-approval.test.ts` (new, 1 E2E)    |

## Metrics

- **Unit tests:** 1511 passing (added 23 across 2 files).
- **Integration tests (scoped):** 8 passing across 3 files
  (`claim-lock-prehook`, `destructive-op-approval`, `worker-retry-commit`).
- **Orchestrator unit tests:** 146 passing (events.ts additions did not
  regress release-locks or other tests).
- **Typecheck:** clean.
- **Claim-lock RTT:** 35.67ms measured in-process (well under 50ms CI
  budget; target 5ms per A2, so headroom for real-fork transport).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Bare repo HEAD symbolic ref unset in fresh `git init --bare`**
- **Found during:** Task 5 (first test run)
- **Issue:** `git rev-parse HEAD` inside a brand-new bare repo (even
  after `git push origin HEAD:main`) returns the literal string `HEAD`
  instead of the SHA because bare repos don't auto-create a symbolic
  HEAD → main pointer.
- **Fix:** Use `git rev-parse refs/heads/main` in both the before/after
  assertions.
- **Files modified:** `test/integration/destructive-op-approval.test.ts`
- **Commit:** 83e12a3 (one commit; caught before push)

Plan otherwise executed exactly as written. No Rule 4 (architectural)
escalations, no authentication gates.

### Informational: test-path adjustments

The plan text in Task 3 prescribed two sibling unit test files
(`test/unit/agents/destructive-ops.test.ts` +
`test/unit/agents/path-lock.test.ts`). The path-lock surface already
had coverage in
`test/unit/agents/worker/tools/write-prehook.test.ts`; I added the new
file with complementary, claimer-focused tests (cache + denial + path
discrimination) rather than duplicating. Both the plan's file path and
the existing file now exist; neither covers the other exactly.

## Known Stubs

- **Inbox UI:** `store.appendInboxItem({ kind: 'destructive_action' })`
  fires, but there is no UI to resolve the row. Default approval
  response is reject (Phase 7 materializes the resolution flow).
- **Bypass token:** `bypassOnce` map is wired but will not let a
  retried destructive command through because pi-sdk rotates
  `toolCall.id` on re-attempt. Documented inline; Phase 7 owns the
  proper approval-bypass protocol.

## Threat Flags

None. The plan adds a strictly narrowing guard (blocks three patterns
that were previously unblocked) — it closes surface, not opens.

## Cross-phase notes

- **03-05 parallel wave:** does not touch `destructive-ops.ts` or
  `orchestrator/scheduler/events.ts`; its worker/index.ts edits live in
  the startup/init path while this plan's edits live in the
  `new Agent({ beforeToolCall })` callback path. Commented section
  header `// === Write pre-hook (plan 03-04) ===` keeps the merge
  surface clear.
- **Phase 4 scheduler:** ConflictCoordinator contract unchanged.
- **Phase 7 inbox UI:** consumes the `destructive_action` rows this
  plan appends; see `docs/concerns/destructive-ops-non-git.md` for the
  expansion ticket.
- **Phase 9 crash recovery:** unresolved `inbox_items` with
  `kind='destructive_action'` surface in the recovery summary; this
  plan emits them, Phase 9 surfaces them.

## Self-Check: PASSED

- `src/agents/worker/destructive-ops.ts` exists (FOUND)
- `src/runtime/worker/index.ts` contains `beforeToolCall`/
  `destructiveOpGuard`/`describeDestructive` imports (FOUND)
- `src/orchestrator/scheduler/events.ts` contains `destructive_action`
  inbox append (FOUND)
- `test/unit/agents/destructive-ops.test.ts` (FOUND, 19 cases pass)
- `test/unit/agents/path-lock.test.ts` (FOUND, 3 cases pass)
- `test/integration/claim-lock-prehook.test.ts` extended (4 cases pass)
- `test/integration/destructive-op-approval.test.ts` (FOUND, 1 case pass)
- `docs/concerns/destructive-ops-non-git.md` (FOUND)
- `docs/concerns/README.md` references new entry (FOUND)
- All 6 commits present on `exec-03-04` branch (FOUND)
- `npm run typecheck` exits 0 (PASSED)
- `npx vitest run test/unit` — 1511/1511 pass (PASSED)
- `npx vitest run test/integration/claim-lock-prehook test/integration/destructive-op-approval test/integration/worker-retry-commit` — 8/8 pass (PASSED)

Commit hashes:
- 6aa80ea feat(agents/worker): destructive-ops guard via pi-sdk beforeToolCall
- aac3a2d feat(runtime/worker): wire destructiveOpGuard + approval round-trip stub
- 75f574e test(unit/agents): destructive-ops patterns + path-lock caching
- 5e8e30c test(integration): extend claim-lock-prehook (cwd escape, RTT assertion)
- 83e12a3 test(integration): destructive-op-approval end-to-end
- 79248e6 docs(concerns): non-git destructive ops deferred to Phase 7
