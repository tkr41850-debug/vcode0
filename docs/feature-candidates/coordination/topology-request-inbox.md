# `topology_request` inbox kind with project-planner click-through

Status: deferred (Step 7.2 of `docs/implementation/02-project-planner/phase-7-escalation-prompt.md`).

## Why deferred

Step 7.1 lands the wiring slice: feature-phase agents (discuss / plan / replan) escalate project-graph topology issues via `request_help` with a `[topology]`-prefixed query. The help query persists on `agent_runs.payload_json`; the run sits at `await_response`; the operator answers via the existing run-row reply path.

Step 7.2 adds optional UX polish: a structured `topology_request` inbox kind plus a TUI click-through that opens project-planner mode pre-seeded with the help-query text. It is gated on a TUI inbox renderer existing on `main`; today none does. Building one expands Step 7.2's scope from "extend an existing renderer" to "design and ship the first inbox-rendering surface in the TUI", which is a bigger commitment than this phase budget allows.

The escalation pathway is functional without 7.2. Operators see topology requests through the standard `await_response` run row.

## Scope when revisited

- `src/core/types/inbox.ts` — extend the kind union with `topology_request`.
- New persistence migration that relaxes the `inbox_items.kind` CHECK constraint (CHECK constraints in SQLite require the rebuild dance: `CREATE TABLE inbox_items_new ...`, `INSERT INTO inbox_items_new SELECT ... FROM inbox_items`, `DROP TABLE inbox_items`, `ALTER TABLE ... RENAME TO inbox_items`, recreate indexes).
- `src/orchestrator/scheduler/events.ts` — detect the `[topology]` prefix on the help-request path and write an `inbox_items` row with `kind='topology_request'`. Today no inbox row is written for `request_help` at all; this would be the first such writer.
- TUI inbox renderer (build or extend) — affordance opens project-planner mode programmatically with the help-query as seeded context. Click-through is a navigation aid only; it does not auto-resolve the originating run, which still sits at `await_response` until the operator replies.

## Detection rule

`[topology]` prefix on the help query, classified at write time. No new tool variant; classification happens in the inbox writer, not in the agent toolset.

## Cross-references

- Step 7.1 commit: `feat(agents/prompts): topology-escalation guidance in feature-planner prompts`
- Step 7.2 spec: `docs/implementation/02-project-planner/phase-7-escalation-prompt.md` lines 99-141
