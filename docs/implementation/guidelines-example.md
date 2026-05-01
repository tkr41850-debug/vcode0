# Implementation Phase Doc Example

Synthetic worked example paired with `guidelines.md`. Not a real phase — illustrates canonical shape end to end. Annotations inline as HTML comments where a choice is non-obvious.

The fictional phase below would live at `docs/implementation/02-project-planner/phase-9-help-channel-rework.md` if it were real. Slug names a single observable change; phase number is identity.

---

# Phase 9 — Help channel rework

- Status: drafting
- Verified state: main @ 33ffb7a on 2026-05-01
- Depends on: phase-3-toolset-split (request_help tool surface), phase-7-escalation-prompt (escalation copy slot)
- Default verify: npm run check:fix && npm run check
- Phase exit: `npm run verify`; `grep -RIn 'HELP:' src/agents` returns zero hits; smoke — run `examples/scripted-help-loop.ts`, confirm planner emits one `help_request` event per blocked tool call and TUI renders the prompt without duplication.
- Doc-sweep deferred: docs/architecture/agents/help-channel.md, docs/reference/tui-events.md

Ships as 3 commits, in order.

## Contract

- Goal: planners route operator-blocking questions through a single `help_request` channel that the TUI renders deterministically, replacing the current ad-hoc mix of stdout prints and tool-result strings.
- Scope:
  - In:
    - New `help_request` IPC frame (planner → host) carrying `{question, context_ref, urgency}`.
    - Host fan-out to TUI event bus + persistence row in `agent_events`.
    - Replace existing `console.error("HELP:")` sites in planner prompt scaffolding.
  - Out:
    - Operator reply path back to planner (owned by phase-10-help-reply-channel).
    - Help-request rate limiting / dedup (tracked in docs/concerns/help-channel-storms.md).
    - Migration of legacy escalation strings in archived feature branches.
- Exit criteria:
  - `grep -RIn 'HELP:' src/agents` returns zero hits.
  - `agent_events` table contains at least one `help_request` row after the smoke scenario.
  - TUI renders the request without falling back to raw-event panel (no `unknown event` warning in logs).
  - All planner integration tests pass; no test asserts on the old stdout path.

## Plan

- Background: planners currently signal blockers via `console.error` strings prefixed `HELP:` at `src/agents/planner/prompt-scaffold.ts:204` and via tool-result text at `src/agents/planner/tools/request-help.ts:58`. The TUI greps event logs for the prefix in `src/tui/event-bus.ts:312`, which means a planner running outside the TUI silently loses the signal. Persistence layer never sees these requests; `agent_events` schema at `src/persistence/sql/004_agent_events.sql:14` has a `kind` enum that lacks `help_request`. Tests at `test/integration/planner-help.spec.ts:42` assert on the stdout prefix and will need rewiring.
- Notes:
  - Open: should `urgency` be a free string or an enum (`info|blocking`)? Draft uses enum; revisit if more levels surface during phase-10 prep.
  - Watch: TUI event bus already buffers; confirm new frame doesn't bypass buffering when emitted during phase-3 toolset init.

## Steps

### 9.1 Add help_request frame and persistence column [risk: med, size: M]

What: extend the IPC frame discriminated union with a `help_request` variant, add `kind = 'help_request'` to the `agent_events.kind` CHECK constraint via a new migration, and wire host-side fan-out to the existing event bus.
Files:
  - `src/runtime/ipc/frames.ts:88`
  - `src/persistence/sql/012_help_request_kind.sql` (new)
  - `src/orchestrator/host/help-router.ts` (new)
Tests:
  - `test/unit/ipc/frames.test.ts` — round-trip parse for new variant.
  - `test/integration/help-router.spec.ts` — host receives frame, writes row, emits TUI event. Use scripted FauxResponse to drive planner.
Review goals:
  1. Migration is additive (no enum value removed) and idempotent under re-run.
  2. Frame zod schema rejects payloads missing `question` or with empty string.
  3. Host fan-out emits to event bus *before* DB write returns, matching pattern at `src/orchestrator/host/event-router.ts:88`.
  4. No legacy `HELP:` references introduced.
Commit: feat(runtime/ipc): add help_request frame and event-kind migration
Rollback: revert this commit; `012_help_request_kind` must also be manually dropped on databases that already migrated (additive enum value, no down-migration).

### 9.2 Cut planner over to help_request and remove HELP prefix [risk: high, size: L]

What: replace the two `console.error("HELP:")` sites and the tool-result text path with `request_help` tool calls that emit the new IPC frame; delete the TUI prefix-grep fallback at `src/tui/event-bus.ts:312`; rewire integration tests to assert on the persisted event row instead of stdout.
Files:
  - `src/agents/planner/prompt-scaffold.ts:204`
  - `src/agents/planner/tools/request-help.ts`
  - `src/tui/event-bus.ts:312`
  - `test/integration/planner-help.spec.ts`
Tests:
  - Existing `planner-help.spec.ts` rewritten; must keep at least one assertion that the planner cannot reach the operator without going through the new frame (regression guard).
  - New TUI render snapshot in `test/integration/tui/help-render.spec.ts`.
Review goals:
  1. Cutover is atomic: no commit lands with both old prefix path and new frame coexisting.
  2. TUI snapshot is deterministic across runs (no timestamps, no random ids in render output).
  3. Test rewire does not weaken regression coverage; old assertion intent (planner must signal before continuing) is preserved.
  4. No silent fallback when frame parse fails — host logs and surfaces error, does not drop the request.
Commit: feat(agents/planner): route help via help_request frame, drop HELP prefix
Smoke: run `examples/scripted-help-loop.ts` against a fresh DB; confirm `agent_events` has one `help_request` row, TUI panel renders the question, and stdout contains zero `HELP:` lines.
Migration ordering: 9.1 must merge before 9.2; 9.2 deletes the fallback path that 9.1's frame replaces. If 9.2 lands first the planner emits a frame the host cannot route.
Crash matrix: if host crashes between IPC receipt and DB write, frame is lost (acceptable for v1; phase-10-help-reply-channel adds retry). If planner crashes after emit, no orphan rows because frame is host-buffered before DB write returns.

### 9.3 Reconcile doc-sweep [risk: low, size: S]

What: update `docs/architecture/agents/help-channel.md` and `docs/reference/tui-events.md` to reflect the `help_request` frame, the `agent_events.kind` enum addition, and the TUI event shape; clear the `Doc-sweep deferred:` header.
Commit: docs(agents): document help_request channel and TUI event surface

---
Shipped in <SHA1>..<SHA2> on <YYYY-MM-DD>
