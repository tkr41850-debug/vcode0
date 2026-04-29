# Feature Candidate: Borrow `absurd` Schema Patterns into SQLite Journal

## Status

Constructive candidate emerging from the [`absurd` evaluation](./absurd-evaluation.md). This is the *yes-half* of the evaluation outcome: direct adoption of `absurd` is rejected, but its SQL schema is the most precise published specification of an agent-aware journal layer and is worth treating as a reference design when gvc0 next touches its persistence schema.

This is a *deferred* candidate. It does not propose a rewrite. It records the patterns to lift when the journal is next revisited — to avoid losing the evaluation's intellectual content between sessions.

## Baseline

gvc0's persistence today (`@persistence/*`, better-sqlite3):

- `agent_runs` rows for per-attempt execution state (retry/backoff, help-wait, approval-wait).
- `tasks`, `features` rows for graph state (derived; git refs are authoritative).
- Event/IPC journal as raw NDJSON.
- Crash recovery is a startup reconciler that reads git + SQLite and reconstructs orchestrator state.

There is no per-step checkpoint table, no first-write-wins event/wait coordination table, and no formal lease-with-recycling pattern.

## Candidate

When the journal schema is next reshaped (e.g., to support per-step idempotent retry, longer crash recovery windows, or richer in-flight state inspection), use `absurd.sql` as the reference design. Specifically borrow:

1. **Per-attempt `runs` rows separate from `tasks` rows.** A single task can have multiple `agent_runs`; each is an immutable attempt record. Lease + claim metadata lives on the run, not the task. This is structurally close to gvc0's existing `agent_runs` but `absurd` formalizes it cleanly.
2. **Checkpoint table keyed by `(task_id, step_name)`** with attempt-number guard and `owner_run_id` linkage. Idempotent step writes (skip on second-attempt arrival) fall out of the schema. Maps cleanly to "every pi-sdk `message_end` is a durable checkpoint."
3. **Events table with first-write-wins semantics** (`INSERT OR IGNORE` / `ON CONFLICT DO UPDATE WHERE payload IS NULL` — both SQLite-native). One-shot named latches for cross-task coordination.
4. **Wait registrations table** — explicit rows representing "task X is waiting for event Y." Cheap, queryable, no polling.
5. **Lease expiry + recycling sweep pattern** — a periodic query that finds runs whose claim expired, marks them recyclable, and re-queues for claim. Works equivalently in SQLite with a `setInterval` driving the cleanup query.
6. **`message_end`-keyed pi-sdk checkpointing as the base pattern** for worker durability. gvc0's harness can wrap pi-sdk's `runAgentLoopContinue` with a `persistEvent` callback that writes a checkpoint per assistant turn and per tool result, identical to `absurd`'s pi-agent integration shape.

## Adaptations Required

`absurd` is Postgres-native; gvc0 is single-process SQLite. Translation table:

| `absurd` (Postgres) | gvc0 (SQLite, better-sqlite3) |
|---|---|
| `FOR UPDATE SKIP LOCKED` claim | `BEGIN IMMEDIATE` + plain SELECT/UPDATE; single-writer serialization replaces row-level skip-past-locked |
| `FOR UPDATE` / `FOR SHARE` row locks | Drop entirely; transaction isolation is sufficient under one writer |
| `pg_cron` cleanup jobs | Node-side `setInterval` calling cleanup SQL |
| Partitioned table sets per queue | Single static schema; gvc0 has no dynamic queue creation |
| `jsonb` columns + operators | `TEXT` columns with `json_extract()` or app-side parse |
| `clock_timestamp()` + session-level fake-now | Inject `nowFn: () => Date` at the SQL boundary |
| `NOTIFY/LISTEN`, advisory locks | Not used by `absurd` — no adaptation needed |

The `SKIP LOCKED` casualty is the most-cited Postgres advantage. It is not a casualty for gvc0: the worker pool is one process with one writer, so there are no concurrent claimers to skip past. Single-writer serialization preserves the same correctness guarantee (no double-claim) without `SKIP LOCKED`.

## Why It Matters

The deep dive established that `absurd`'s SQL schema is a *precise specification* of an agent-aware journal. It encodes opinions on:

- Where the durability boundary should sit (per `message_end`).
- How retries should interact with idempotent steps (skip-on-replay via checkpoint cache).
- How cross-task coordination should be modeled (events + waits, not polling).
- How worker death should be handled (lease expiry + recycling, not heartbeat-based liveness).

These opinions are tested in production (per Armin Ronacher's [April 2026 production post](https://lucumr.pocoo.org/2026/4/4/absurd-in-production/)). gvc0 has approximately the same opinions but its current schema does not encode them as cleanly. When the schema is next reshaped, the borrowing cost is low and the correctness payoff is high.

## What Does *Not* Get Borrowed

`absurd` covers only the parts of state that map to its model. gvc0 needs more than that:

- **Per-run dynamic backoff state** (computed from API errors). Not in `absurd`. Stays in `agent_runs`.
- **Help-wait / approval-wait flags**. Not in `absurd`. Stays in `agent_runs`.
- **Sub-tool-batch granularity for parallel tool calls**. `absurd` re-runs the whole tool batch when crash falls inside an assistant turn; gvc0 currently has finer granularity via its IPC event journal. Keep that finer granularity if it carries weight; do not regress to `absurd`'s coarser shape.
- **Feature-affine workers, worktree reservation, DAG scheduling**. Entirely outside `absurd`'s model and entirely inside gvc0's differentiation. Not portable.

## Why Deferred

- The current journal works. Crash recovery passes integration tests. There is no acute pain that adopting these patterns would relieve immediately.
- A schema reshape is more risk than a schema preservation. It should ride on top of an existing motivation (e.g., shipping per-step idempotent retry, or supporting longer suspend/resume windows), not stand alone.
- The patterns are well-documented in `absurd.sql`, which lives at a stable URL. Re-fetching the spec when the work happens is cheap.

## When to Promote

Promote to active work when any of:

- gvc0 ships a feature that requires per-step idempotent retry (e.g., a long verification phase that must resume mid-stream after orchestrator crash without re-running expensive earlier steps).
- gvc0 ships richer cross-task coordination than current event signals support.
- A persistent crash-recovery edge case surfaces that the current reconciler model handles awkwardly and an `absurd`-shaped journal would handle cleanly.
- The `agent_runs` table starts accumulating ad-hoc columns to encode "one attempt of a task" — a sign the per-attempt-row pattern would clean things up.

## Public references

- `absurd` SQL: <https://raw.githubusercontent.com/earendil-works/absurd/main/sql/absurd.sql> — the reference spec.
- `absurd` pi-agent pattern: <https://earendil-works.github.io/absurd/patterns/pi-ai-agent/>.
- Production post: <https://lucumr.pocoo.org/2026/4/4/absurd-in-production/>.
- Topic pages: [absurd-evaluation.md](./absurd-evaluation.md), [durable-execution.md](../../compare/research/durable-execution.md), [pi-ecosystem-post-earendil.md](../../compare/research/pi-ecosystem-post-earendil.md).

## Notes Carried Forward From the Evaluation

- Direct adoption of the `absurd` library was rejected for four independent structural reasons: TS SDK is incompatible with process-per-task; scheduler model is FIFO with no DAG; pi-agent integration is shallower than gvc0's IPC journal; Postgres-only with no path back to SQLite. Pattern-borrowing has none of these blockers.
- The pattern-borrow approach preserves gvc0's git-refs-authoritative property unchanged: this candidate touches *only* the SQLite journal layer, not graph state.
- This candidate is the constructive complement to [absurd-evaluation.md](./absurd-evaluation.md). The evaluation closes "should we adopt it?" with no; this candidate opens "what should we lift from it?" with a list.
