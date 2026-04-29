# Feature Candidate: `absurd` Evaluation

## Status

Evaluation **landed 2026-04-29**. Verdict: direct adoption rejected for four independent structural reasons (below). The constructive output is [absurd-pattern-borrow.md](./absurd-pattern-borrow.md), which records the schema patterns to lift when gvc0 next touches its journal layer.

This page now serves as the historical record of the evaluation question and outcome. Originally surfaced from the [2026-04-29 deep-dive synthesis](../compare/2026-04-29-deep-dive-synthesis.md).

## Baseline

gvc0's state model:

- **Authoritative**: git refs (branches, worktrees, merge state). The merge train operates on git directly; recovery semantics fall out of `git status` + the persisted task table.
- **Derived bookkeeping**: SQLite via `better-sqlite3`. Tables for `agent_runs`, `tasks`, `features`, events, and scheduling state.
- **Transport**: NDJSON over stdio between orchestrator and worker subprocesses.

There is no dedicated durable-execution engine. Crash recovery is a startup reconciler that reads git + SQLite and reconstructs in-memory orchestrator state.

## Candidate

Evaluate Earendil's `absurd` (Postgres-native durable workflow engine for Pi agents) as a complement — not a replacement — for the orchestrator's *internal scheduling state*. Specifically:

- Graph state stays git-authoritative. Not negotiable.
- Worker outputs (squash-merge + verify-issue payload) stay git + SQLite. Not negotiable.
- The question: does `absurd` improve the *scheduler's own* in-flight bookkeeping (which task is being dispatched, retry/backoff state, in-flight feature-phase runs, suspend/resume state) without compromising the git-authoritative property elsewhere?

## Evaluation Questions

1. **API fit.** Does `absurd`'s workflow-and-step model map cleanly to gvc0's "feature-phase run" or "task worker run" granularity? Or is the impedance mismatch large enough that adopting it requires reshaping gvc0's scheduling boundary?
2. **State boundary.** Can `absurd` host scheduler state (which run is dispatched, who's waiting on what) while gvc0 keeps graph state in git + SQLite? Or does `absurd` want to own "everything that durably persists"?
3. **Crash semantics.** When the orchestrator crashes mid-dispatch, does `absurd` give cleaner recovery than the current startup reconciler? Or is the win marginal because git refs already encode most recoverable state?
4. **Operational footprint.** Postgres-native means a Postgres dependency. Today gvc0 ships with embedded SQLite and zero external services. The operational delta is real and needs honest accounting.
5. **License compatibility.** `absurd` is part of Earendil's commercial product surface and may ship under fair-source DOSP. `pi-agent-core` (gvc0's actual dependency) is MIT-permanent under RFC 0015, but `absurd` may not be. Worth confirming before adopting.
6. **Migration path.** If `absurd` is adopted later, what does the migration look like? Is there a reversible adoption (run both, dual-write, cut over) or is it one-way?

## Evaluation Findings (2026-04-29)

Two-round subagent investigation: round 1 mapped the territory (README, docs, SQL, blog posts, HN); round 2 ran four parallel deep dives on schema portability, pi-agent integration, scheduler/DAG fit, and TypeScript SDK internals. Sources: `https://github.com/earendil-works/absurd`, `https://earendil-works.github.io/absurd/`, the `absurd.sql` schema, the TS SDK in `sdks/typescript/src`, Armin Ronacher's [April 2026 production post](https://lucumr.pocoo.org/2026/4/4/absurd-in-production/), and the [HN discussion](https://news.ycombinator.com/item?id=45797228).

### Verdict: direct adoption rejected

Four independent structural blockers, any one of which is sufficient:

1. **TS SDK is incompatible with process-per-task.** `TaskContext` is a live `pg.Pool` handle — not serializable across process boundaries. Handlers run as in-process coroutines; `fatalOnLeaseTimeout=true` (the default) calls `process.exit(1)` if a long subprocess does not checkpoint within 2× the lease. There is no IPC, no `child_process` integration, no extensibility hook for "wrap a task in a separate worktree." Reduces to a pg-backed job queue with retry — gvc0's existing SQLite already covers that.
2. **Scheduler model is architecturally opposed.** No `parent_id` column, no DAG primitives, strict FIFO claim ordered by `(available_at, run_id)` with no priority/affinity hooks. Critical-path EFT, milestone bias, reservation overlap penalties, feature-affine workers, worktree reservation — none expressible. Cross-feature merge-train coordination has structural friction with first-write-wins events (slot-reopen requires unique event names per epoch, defeating the point).
3. **Pi-agent integration is shallower than gvc0's IPC journal.** `absurd` checkpoints at `message_end` only — assistant message and each tool result. Missing: dynamic per-run backoff state (computed from API errors), help-wait / approval-wait flags, sub-tool-batch granularity for parallel tool calls (a crash mid-batch re-runs the whole batch, which gvc0 today does not). Tools *re-execute* on retry within an assistant turn.
4. **Postgres-only with no clean path back to SQLite.** `SKIP LOCKED`, `pg_cron`, `FOR UPDATE`/`FOR SHARE`, partitioning, `jsonb` operators — all Postgres-specific. The semantics are translatable to SQLite, but not by adopting `absurd` as a library; only by lifting the schema design. Adopting `absurd` directly means adopting Postgres as a dependency.

### What does survive: pattern-borrowing

The `absurd.sql` schema is a precise, production-tested specification of an agent-aware journal layer. The portable substance:

- Per-attempt `runs` rows separate from `tasks` rows, with lease + claim metadata on the run.
- Checkpoint table keyed by `(task_id, step_name)` with attempt-number guard and `owner_run_id` linkage; `ON CONFLICT DO UPDATE` for idempotent writes (SQLite-native).
- Events table with first-write-wins (`INSERT OR IGNORE`); waits registration table for cross-task coordination.
- Lease expiry + recycling sweep pattern (a periodic query, not heartbeat-based liveness).
- `message_end`-keyed pi-sdk checkpointing as the base pattern (augmented with explicit gvc0 checkpoints for backoff/approval state).

`SKIP LOCKED` is the most-cited Postgres advantage but is not a casualty for gvc0 — single-writer SQLite with `BEGIN IMMEDIATE` preserves the no-double-claim guarantee without it, because gvc0's worker pool runs in one process with one writer.

This pattern-borrowing path is tracked as a separate candidate: [absurd-pattern-borrow.md](./absurd-pattern-borrow.md). The `absurd` library itself is not adopted; the schema design is treated as a reference spec when the journal is next reshaped.

## Why It Matters

`absurd` is the most interesting deliverable from the post-Earendil ecosystem because:

- It's built by the same people who maintain `pi-agent-core`. Impedance mismatch with pi-sdk semantics is likely lower than with Temporal / Restate / Inngest / DBOS.
- It targets agent-shaped workflows specifically (long tool calls, in-flight steering, retry-with-modified-context).
- Postgres-native is a known operational substrate; no new ops surface to learn.

The synthesis recommends a sprint of evaluation, not adoption. The downside scenario is "we evaluate, conclude the impedance is wrong or the operational footprint is unjustified, and document why we declined." That's a useful artifact even if the answer is no.

## How the Evaluation Would Run

1. **Install + run examples.** Bring `absurd` up against a local Postgres; walk through its tutorial workflows. Establish baseline familiarity.
2. **Map gvc0 scheduler state to `absurd` primitives on paper.** Identify which gvc0 entities map to `absurd` workflows, which map to steps, and which don't fit.
3. **Build a throwaway proof-of-concept** for one narrow surface: dispatch + retry/backoff for a single feature-phase run. Not integrated; isolated.
4. **Measure**: lines of code (gvc0 retains this state today; what does `absurd` save?); recovery semantics on simulated crash; operational complexity.
5. **Decide**: write up findings as a regular `docs/compare/` page with a clear recommendation (adopt, reject, partial-adopt, defer-pending-X).

## Why Direct Adoption Is Rejected (post-evaluation)

The four blockers above settle the question of adopting `absurd` as a library. The original deferral reasoning still holds and the evaluation findings reinforce it:

- The current state model works. Crash recovery is exercised in integration tests; the merge train is invariant-protected. There was no acute pain to relieve.
- Postgres dependency is a real operational tax that single-developer or small-team installs would feel acutely. `absurd` has no SQLite mode and the SDK is hard-wired to `pg.Pool`.
- `absurd` is pre-1.0 public preview. The TS SDK exposes no extensibility hooks (no `onClaim`, no transport substitution, no per-task lease tuning) — a forced migration when v1 lands would be more, not less, expensive than expected.
- The git-refs-authoritative property is gvc0's strongest moat. `absurd`'s checkpoint model wants to own per-step durable state, which would split authority unless gvc0 reduced `absurd` to a job-queue role — at which point gvc0's existing SQLite already suffices.

## Adoption Decision

Direct adoption: **no**. Pattern-borrowing: **yes, when the journal is next reshaped**. See [absurd-pattern-borrow.md](./absurd-pattern-borrow.md).

The evaluation is closed. Re-opening would require:

- `absurd` v1 introducing a SQLite mode (unlikely — Postgres is an explicit design choice per the production post).
- gvc0's process-per-task model changing to in-process workers (a separate, very large architectural shift).
- A documented case study of a Pi-sdk-based DAG orchestrator successfully adopting `absurd` (would update the prior on integration cost).

## Public references

- Earendil `absurd`: <https://earendil.dev/absurd/>
- RFC 0015 (licensing): <https://earendil.dev/rfcs/0015-licensing.md>
- Topic pages: [durable-execution.md](../compare/durable-execution.md), [pi-ecosystem-post-earendil.md](../compare/pi-ecosystem-post-earendil.md).

## Notes Carried Forward From Design Discussion

- Considered evaluating Temporal instead. Rejected as first move: higher impedance mismatch (Temporal isn't agent-shaped), higher operational footprint, no shared author with pi-sdk. `absurd` is the closest match; if `absurd` doesn't fit, Temporal almost certainly doesn't either.
- Considered evaluating LangGraph for the same role. Rejected: LangGraph's checkpointing is between-step only, which is *worse* than gvc0's current model for in-flight tool calls. See [durable-execution.md](../compare/durable-execution.md).
- Considered adopting `absurd` for graph state too. Rejected without further investigation: the git-refs-authoritative property is non-negotiable; splitting authority is the failure mode to avoid.
