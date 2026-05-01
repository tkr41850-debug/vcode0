# Phase Review — Haiku 3, persistence & schema consistency

Current repo baseline, from `/home/alpine/vcode0/src/persistence/migrations/`, is `001` through `009`, with `009_agent_run_harness_metadata.ts` the latest applied schema step in-tree today. Current `Store` in `/home/alpine/vcode0/src/orchestrator/ports/index.ts` only covers `agent_runs`, `events`, and the `integration_state` singleton; current `/home/alpine/vcode0/src/persistence/sqlite-store.ts` matches that narrow surface.

This review focuses only on persistence, schema, migration ordering, and port-surface consistency across the five distributed-runtime phase docs.

## Critical issues (block landing)

- **Migration numbering is not anchored to the actual repository baseline.**
  - The real in-repo max migration today is `009_agent_run_harness_metadata.ts`.
  - Phase 1 step 1.3 claims `012_workers.ts`.
  - Phase 3 step 3.1 claims `010_agent_run_owner_worker.ts`.
  - Phase 3 step 3.6 claims `011_agent_run_owner_index.ts`.
  - Phase 5 step 5.1 and step 5.9 still use placeholders (`0NN_*`, `0NN+1_*`).
  - That means the plan does not currently define one contiguous chain from the schema that actually exists in `/home/alpine/vcode0/src/persistence/migrations/`.
  - The prose explanation is also self-contradictory: `02-distributed/README.md` says this track assumes `01-baseline` has merged, but the checked-in repo does not contain the referenced baseline `010`/`011` migrations.
  - Persistence work cannot safely start from “maybe 010, maybe 012, maybe renumber later”. The migration IDs need to be pinned before implementation.
  - Recommended fix: pick one concrete post-`009` sequence now and update every phase doc to that sequence. A straightforward chain would be `010 workers`, `011 agent_run owner columns`, `012 owner index`, `013 run_leases + fence_token`, `014 drop worker_pid/worker_boot_epoch`.

- **Session persistence has three incompatible authorities across phases.**
  - `02-distributed/README.md` says distributed workers force a choice, and strongly hints centralized conversation persistence becomes a dependency.
  - Phase 2 step 2.3 explicitly chooses centralized orchestrator-owned sessions via `RemoteSessionStore` proxying to the existing `SessionStore` port.
  - Phase 3 step 3.4 then introduces per-run worker-local `FileSessionStore` directories under `<workerScratch>/sessions/<agentRunId>/`.
  - Phase 3 step 3.5’s sticky-resume fallback relies on “the session lives on the dead worker”, which only makes sense if the worker-local model won.
  - Phase 4 known gaps then says the phase “keeps disk-backed `FileSessionStore`” unless phase 2 already centralized it.
  - Phase 5 step 5.4 reopens the question again by adding `SessionStore.isResumableForWorker(...)` with two branches: centralized `=>` trivial true, worker-authoritative `=>` RPC.
  - This is not harmless wording drift. It changes recovery semantics:
    - centralized sessions imply takeover can resume on a different worker with the same `sessionId`;
    - worker-authoritative sessions imply takeover often must restart or migrate session state.
  - The plan currently uses both assumptions in different places.
  - Persistence-wise, the result is that `session_id` means different things in different phases.
  - The plan needs one authoritative session storage model, then phases 3–5 need to be rewritten to match it.

- **Run ownership is duplicated across three different schema locations with no declared canonical source.**
  - The baseline schema already has `tasks.worker_id` in `001_init.ts`.
  - Phase 3 adds `agent_runs.owner_worker_id` and `agent_runs.owner_assigned_at`.
  - Phase 5 adds `run_leases.worker_id`, `run_leases.granted_at`, `run_leases.expires_at`, `run_leases.state`, and `agent_runs.fence_token`.
  - Phase 2’s prerequisite section even says phase 1 already gives `agent_runs` a worker id or equivalent, but phase 1 does not add that column. Phase 3 is the first place that actually does.
  - After phase 5, the docs never retire `agent_runs.owner_worker_id` / `owner_assigned_at`.
  - That leaves:
    - `tasks.worker_id` — existing task-level worker field;
    - `agent_runs.owner_worker_id` / `owner_assigned_at` — phase-3 run owner field;
    - `run_leases.worker_id` / `granted_at` — phase-5 lease owner field.
  - The data overlaps semantically.
  - The timestamps overlap semantically too: `owner_assigned_at` and `granted_at` both describe “when did this worker become owner?”.
  - If `run_leases` is authoritative in phase 5, `owner_worker_id` is at best a denormalized mirror and at worst a stale second truth.
  - The plan must either:
    - explicitly retire `tasks.worker_id` and `agent_runs.owner_worker_id` in favor of `run_leases`, or
    - explicitly define them as stable mirrors with strict write rules.
  - As written, the ownership story is split-brain.

- **Phase 4 changes `agent_runs.payload_json` semantics without defining the persisted JSON contract, and phase 5 does not fence the relevant write path.**
  - Today, proposal payload persistence is not just “store a `GraphProposal` blob”.
  - Current orchestrator code reads and rewrites structured proposal payload state in `/home/alpine/vcode0/src/orchestrator/scheduler/events.ts` and `/home/alpine/vcode0/src/orchestrator/services/recovery-service.ts`.
  - That persistence contract includes more than the raw proposal; it also carries recovery/decision metadata used by approval and replay paths.
  - Phase 4 step 4.5 says `proposal_submitted` writes `agent_runs.payload_json` on submit.
  - Phase 4 step 4.6 then says compare `agent_runs.payload_json` between in-process and remote paths.
  - But the docs never say whether remote persistence stores:
    - the current structured stored-payload envelope,
    - the raw `GraphProposal`,
    - `proposal + details + submissionIndex`, or
    - some new wrapper.
  - That is a schema-contract gap even though there is no new DB column.
  - It matters because approval/recovery code already depends on exact JSON shape.
  - Phase 5 then fences `result`, `error`, `claim_lock`, `request_help`, and `request_approval`, but does not say `proposal_submitted` is fenced.
  - `proposal_submitted` is not just UI chatter; phase 4 uses it to mutate persisted `agent_runs.payload_json`.
  - Without fence enforcement on that path, a stale worker can overwrite proposal payload after takeover.
  - The plan needs two explicit fixes:
    - define the `payload_json` envelope that remote proposal submit persists, and state it is identical to the current local/recovery envelope;
    - include proposal-persistence frames in phase 5 fence enforcement.

- **The `Store` port evolution is internally inconsistent once leases/fences land.**
  - Current `Store` is small and clear:
    - `get/list/create/updateAgentRun`
    - `list/appendEvent`
    - `get/write/clearIntegrationState`
  - Phase 3 cleanly extends this with `AgentRunQuery.ownerWorkerId` and `listRunsByOwner(workerId)`.
  - Phase 5 step 5.1 then adds lease-specific methods: `grantLease`, `getLease`, `renewLease`, `expireLease`, `listExpiredLeases`.
  - So far, fine.
  - But phase 5 background and step 5.5 also require worker-attributable `Store.updateAgentRun` calls to carry `expectedFence` so `SqliteStore.updateAgentRunTxn` can reject stale writers.
  - That is a real port-surface change.
  - The step never updates `/home/alpine/vcode0/src/orchestrator/ports/index.ts` to reflect it.
  - The plan therefore has an undocumented API delta on the most central persistence method in the system.
  - There is a second port smell here too: `getLease` is added in step 5.1, but no later phase step actually consumes it.
  - Recommended fix:
    - either add the `updateAgentRun(..., options?: { expectedFence?: number })` change explicitly in phase 5,
    - or keep `updateAgentRun` unchanged and route all fence-checked writes through dedicated lease-aware store helpers.
  - Right now the docs ask implementers to change the Store contract implicitly.

## Significant issues (worth addressing)

- **Phase 5 step 5.1’s rollback note is incorrect.**
  - The step says rollback is a `DROP TABLE`.
  - But the migration also does `ALTER TABLE agent_runs ADD COLUMN fence_token INTEGER NOT NULL DEFAULT 0`.
  - Dropping `run_leases` does not roll back `agent_runs.fence_token`.
  - If rollback is out of scope, say so plainly.
  - If rollback matters, document the actual SQLite rebuild needed.

- **The cited “rebuild pattern” for dropping columns does not exist in the current migrations.**
  - Phase 5 background and step 5.9 cite `006_rename_feature_ci_to_ci_check.ts` as the example rebuild pattern.
  - Current `006_rename_feature_ci_to_ci_check.ts` is only a data rewrite over `features`, `agent_runs`, and `events`.
  - It does not show a `CREATE TABLE ... AS SELECT` or rename/copy/drop pattern.
  - That makes the drop-column guidance misleading.
  - The plan should point to a real in-repo example, or acknowledge that this will be the first table-rebuild migration in the codebase.

- **`run_leases` is indexed for time and worker, but not for the actual sweep predicate.**
  - Step 5.1 adds:
    - `idx_run_leases_expires` on `expires_at`
    - `idx_run_leases_worker` on `worker_id`
  - Step 5.4’s hot query is conceptually “active leases whose `expires_at + grace` is before now”.
  - Once old rows accumulate in states `expired` and `released`, an `expires_at`-only index becomes noisier.
  - A partial index on active leases, or a composite `(state, expires_at)` index, matches the sweep far better.
  - This is the one new truly hot persistence path in phase 5; the plan should tune it explicitly.

- **`tasks.worker_id` is left hanging.**
  - The current persisted task shape already carries `workerId?: string` in `/home/alpine/vcode0/src/core/types/domain.ts`, backed by `tasks.worker_id` from `001_init.ts`.
  - None of the distributed phases say whether this field:
    - stays authoritative for task assignment,
    - mirrors current run ownership,
    - is legacy/dead, or
    - should be retired in favor of run-level ownership.
  - That ambiguity matters for readers, codecs, TUI state, and any future queries.
  - At minimum, phase 3 should state how `tasks.worker_id` relates to `agent_runs.owner_worker_id`.
  - If it is obsolete, phase 5 is the natural place to drop it.

- **The lack of foreign keys on worker-owner fields may be intentional, but the docs never say why.**
  - `workers.worker_id` exists after phase 1.
  - Phase 3 adds `agent_runs.owner_worker_id TEXT` without an FK.
  - Phase 5 adds `run_leases.worker_id TEXT NOT NULL` without an FK.
  - That may be correct if synthetic IDs like `'local'` are allowed and are never persisted in `workers`.
  - It may also be correct if lease records can outlive worker rows.
  - But because the docs do not explain the absence of the FK, the schema looks half-normalized.
  - One sentence would fix this: either “no FK because local worker IDs are synthetic” or “add FK because all owners must be registered workers”.

- **Phase 3 background and step text drift on the Store query surface.**
  - The background section says `Store` gains `listWorkerLoad()` or similar.
  - The actual steps add `AgentRunQuery.ownerWorkerId` and later `listRunsByOwner(workerId)`.
  - That is not a functional bug, but it makes the phase harder to reason about because the port shape changes mid-doc.
  - Pick one API and use that name consistently.

- **`owner_assigned_at` looks write-heavy but query-light.**
  - Phase 3 adds the column.
  - No later phase query or index explicitly uses it.
  - The operator surface in step 3.6 does not mention displaying it.
  - If its only purpose is internal scheduling tie-break history, it does not belong in durable schema.
  - If it is intended for durable debugging/audit, phase 3 or 5 should say who reads it.

- **Phase 4 makes a real persistence-contract change without a migration, and the docs should call it that.**
  - There is no DDL in phase 4.
  - But phase 4 absolutely changes persistence semantics by making remote workers produce persisted proposal payloads and verification outputs through existing columns.
  - “No migration” is true.
  - “No persistence contract change” is false.
  - The doc would be clearer if phase 4 explicitly said it is a serialized-payload contract migration on existing `payload_json`, not a schema migration.

## Minor / nits

- **Several review prompts call `ALTER TABLE ADD COLUMN` “idempotent”.**
  - Under the current `MigrationRunner`, safety comes from `schema_migrations`, not from the SQL being intrinsically idempotent.
  - That wording is imprecise in phase 3 step 3.1 and phase 5 step 5.1.

- **Phase 5 still contains literal migration placeholders.**
  - `0NN_run_leases.ts`
  - `0NN+1_drop_worker_pid_columns.ts`
  - Those should be filled before implementation starts, not during implementation.

- **Phase 1’s `idx_workers_last_seen_at DESC` is probably fine, but the intended query pattern is unstated.**
  - If the registry always serves from in-memory cache, the index is mostly for occasional operator reads.
  - If future SQL queries scan for stale workers by threshold, index direction is largely irrelevant.
  - One short note about intended use would help.

- **Phase 4 step 4.3’s test claim about `agent_runs.payload_json` parity for text phases looks suspicious.**
  - Text phases today do not have the same stable `payload_json` semantics as planner/replanner approval flows.
  - The safer assertion is “no unexpected payload mutation unless the scope already uses payload persistence”.

- **If `owner_assigned_at` survives, consider whether it should be nullable forever or backfilled at assignment boundaries only.**
  - The column is fine as nullable.
  - But the doc should say whether terminal completion clears it along with `owner_worker_id` or intentionally keeps historical assignment time.
  - The step text currently says clear both; that makes it a pure live-state field, not audit history.

## Cross-phase inconsistencies

- **Phase 1 vs current repo state**
  - Phase 1 is written as if baseline `010` and `011` already exist.
  - The checked-in repo does not contain them.
  - Migration numbering is therefore based on an assumed schema, not the actual schema implementers will start from.

- **Phase 2 vs phase 3 vs phase 4 vs phase 5 on session authority**
  - Phase 2: centralized orchestrator authority.
  - Phase 3: worker-local per-run authority.
  - Phase 4: “keeps disk-backed `FileSessionStore`” unless phase 2 already centralized.
  - Phase 5: both branches remain supported by `isResumableForWorker`.
  - This is the biggest persistence contradiction in the track.

- **Phase 2 prerequisite text vs actual schema evolution**
  - Phase 2 says phase 1 already gives `agent_runs` a worker id/equivalent.
  - Phase 1 does not.
  - Phase 3 is where run-owner columns first appear.
  - The prose dependency is ahead of the schema dependency.

- **Phase 3 owner fields vs phase 5 lease fields**
  - Phase 3 treats `agent_runs.owner_worker_id` as durable run ownership.
  - Phase 5 says `run_leases` becomes the authoritative ownership record.
  - No phase explicitly demotes or removes the phase-3 columns.
  - That leaves ownership duplicated indefinitely.

- **Phase 3 sticky resume vs phase 5 takeover semantics**
  - Phase 3 sticky resume says an unknown previous worker should trigger `mode: 'start'` because session state may live on that dead worker.
  - Phase 5 lease takeover says resume on a different worker with the same `sessionId`.
  - Those are different persistence assumptions about the same field.
  - This inconsistency disappears only if phase 2’s centralized session model is made authoritative.

- **Phase 4 proposal persistence vs current recovery readers**
  - Phase 4 uses existing `payload_json` but never names the exact stored envelope.
  - Current recovery/approval paths already parse that envelope.
  - A “same data, new producer” migration only works if the persisted JSON stays byte-compatible at the contract level.

- **Phase 4 proposal submit vs phase 5 fence list**
  - Phase 4 persists proposal submit checkpoints.
  - Phase 5 fences several mutating worker frames but does not mention the proposal submit path.
  - That is a persistence consistency gap, not just a runtime one.

- **Phase 5 update fencing vs current Store port**
  - Phase 5 needs stale-writer rejection inside `updateAgentRun`.
  - The phase docs do not actually evolve the port definition to support that.
  - The Store contract and the sqlite implementation plan diverge.

- **Phase 5 column drop vs phase 3-added columns**
  - Step 5.9 says rebuild `agent_runs` and preserve “every other column verbatim”.
  - It never enumerates the final kept column set.
  - Given phase 3 adds owner columns and phase 5 adds `fence_token`, the absence of an explicit final schema is risky.

## Schema timeline

- **Baseline before the distributed track (current checked-in repo state)**
  - Tables in scope already present:
    - `agent_runs`
    - `events`
    - `integration_state`
    - plus domain tables like `features`, `tasks`, `dependencies`, `milestones`
  - Existing `tasks` columns already include:
    - `worker_id`
    - `worktree_branch`
    - `session_id`
  - Existing `agent_runs` columns already include:
    - `session_id`
    - `payload_json`
    - `token_usage`
    - `harness_kind`
    - `worker_pid`
    - `worker_boot_epoch`
    - `harness_meta_json`
  - Current `SqliteStore` persists only:
    - `agent_runs`
    - `events`
    - `integration_state`

- **Phase 1 step 1.3 — adds `workers` table**
  - New table: `workers`
  - New columns inside it:
    - `worker_id` PK
    - `boot_epoch`
    - `capabilities_json`
    - `capacity_max_concurrent`
    - `agent_name`
    - `agent_version`
    - `first_seen_at`
    - `last_seen_at`
  - New index:
    - `idx_workers_last_seen_at`
  - End-of-step schema state:
    - baseline tables still unchanged
    - worker registry persistence exists separately from `Store`

- **End of phase 1**
  - Schema delta from baseline:
    - add `workers`
    - no changes yet to `agent_runs`
    - no changes yet to `tasks`
  - Important persistence implication:
    - registry data is persisted
    - run ownership is still not persisted by worker identity

- **Phase 2 — no DB migration described**
  - No new table
  - No new column
  - No new index
  - Persistence contract changes without DDL:
    - session authority is supposed to move behind `SessionStore`
    - remote task execution starts relying on centralized or remote-proxied session persistence
    - bare-repo authorization will need DB lookups, but phase 2 does not add schema for it

- **End of phase 2**
  - Physical schema should still match end of phase 1
  - Logical persistence contract has changed:
    - `session_id` becomes more central
    - remote task branches now depend on persisted run/branch identity
  - This is exactly why the session-authority contradiction with later phases is so important

- **Phase 3 step 3.1 — adds run-owner columns to `agent_runs`**
  - New columns on `agent_runs`:
    - `owner_worker_id TEXT`
    - `owner_assigned_at INTEGER`
  - No backfill
  - Intended semantics:
    - set on dispatch
    - clear on terminal completion
  - End-of-step schema state:
    - `agent_runs` now carries both local-process liveness fields (`worker_pid`, `worker_boot_epoch`) and distributed owner fields (`owner_worker_id`, `owner_assigned_at`)

- **Phase 3 step 3.6 — adds owner lookup index**
  - New index on `agent_runs`:
    - `idx_agent_runs_owner_worker ON agent_runs(owner_worker_id) WHERE owner_worker_id IS NOT NULL`
  - End-of-step schema state:
    - operator query path can cheaply answer “what runs does worker X own?”
    - ownership is still duplicated against existing `tasks.worker_id`

- **End of phase 3**
  - New persisted structures now in play:
    - `workers`
    - `agent_runs.owner_worker_id`
    - `agent_runs.owner_assigned_at`
    - owner partial index
  - Legacy local liveness fields still remain:
    - `worker_pid`
    - `worker_boot_epoch`
  - No lease table yet
  - No fence token yet

- **Phase 4 — no DDL, but a real payload-persistence contract change**
  - No new table
  - No new column
  - No new index
  - But `agent_runs.payload_json` becomes more important:
    - remote planner/replanner workers now produce checkpoint submissions
    - orchestrator writes proposal submit state coming from the network
    - approval/recovery continue reading the same column
  - End-of-phase schema state should still be physically identical to end of phase 3
  - The hidden migration here is semantic, not structural:
    - same column
    - broader producer set
    - stricter need for exact JSON-shape compatibility

- **Phase 5 step 5.1 — adds leases and fence token**
  - New table: `run_leases`
  - New columns inside it:
    - `agent_run_id` PK/FK to `agent_runs(id)`
    - `worker_id`
    - `fence_token`
    - `granted_at`
    - `expires_at`
    - `state`
  - New indexes:
    - `idx_run_leases_expires`
    - `idx_run_leases_worker`
  - New column on `agent_runs`:
    - `fence_token INTEGER NOT NULL DEFAULT 0`
  - End-of-step schema state:
    - run ownership now exists both as phase-3 owner columns and phase-5 lease rows
    - stale-writer protection is now partly persisted in `agent_runs`

- **Phase 5 steps 5.2–5.8 — no additional DDL described**
  - Store/API behavior changes only:
    - grant/renew/expire/query leases
    - use `fence_token`
    - consume `run_leases`
  - Physical schema should stay identical to step 5.1 through these steps

- **Phase 5 step 5.9 — drops legacy local-worker liveness columns from `agent_runs`**
  - Drops columns:
    - `worker_pid`
    - `worker_boot_epoch`
  - Intended via SQLite table rebuild, not `ALTER TABLE DROP COLUMN`
  - Ambiguity to resolve before landing:
    - does rebuild preserve `owner_worker_id`, `owner_assigned_at`, and `fence_token`?
    - or is phase 5 also supposed to retire the phase-3 owner columns?

- **End of phase 5 (intended)**
  - Definitely present:
    - `workers`
    - `run_leases`
    - `agent_runs.fence_token`
  - Definitely removed:
    - `agent_runs.worker_pid`
    - `agent_runs.worker_boot_epoch`
  - Unclear from docs:
    - whether `agent_runs.owner_worker_id` survives
    - whether `agent_runs.owner_assigned_at` survives
    - what happens to baseline `tasks.worker_id`
  - That ambiguity should be resolved in the plan, not deferred to implementation.

## Migration numbering audit

Current checked-in max migration is `009_agent_run_harness_metadata.ts`.

| Phase | Step | Claimed migration number | Existing migration with same number? | Notes |
| --- | --- | --- | --- | --- |
| Baseline repo | current state | `001`–`009` | yes | Current repo actually stops at `009`; this is the only concrete in-tree baseline. |
| Phase 1 | 1.3 | `012_workers` | no | No collision in current tree, but it skips `010`/`011` based on out-of-tree assumptions. |
| Phase 2 | all steps | none | n/a | No schema migration described. |
| Phase 3 | 3.1 | `010_agent_run_owner_worker` | no | No collision in current tree, but lower than phase 1’s claimed `012`. |
| Phase 3 | 3.6 | `011_agent_run_owner_index` | no | No collision in current tree; depends on 3.1’s `010`. |
| Phase 4 | all steps | none | n/a | No DDL, but `payload_json` contract changes implicitly. |
| Phase 5 | 5.1 | `0NN_run_leases` | no | Placeholder, not a real number yet. |
| Phase 5 | 5.9 | `0NN+1_drop_worker_pid_columns` | no | Placeholder, depends on step 5.1 but still unnumbered. |

Numbering conclusions:

- There are **no literal same-number collisions in the current repo yet**, because most proposed files do not exist.
- There **is** a cross-doc numbering conflict in the plan itself:
  - phase 1 assumes the chain starts at `012`
  - phase 3 assumes it starts at `010`
  - phase 5 does not choose numbers at all
- Relative to the actual repo state, the plan is **not contiguous today**.
- Dependency order is only partly defined:
  - phase 3 step 3.6 clearly depends on phase 3 step 3.1
  - phase 5 step 5.9 clearly depends on phase 5 step 5.1
  - the global chain across phases is not pinned because the numbering baseline is unsettled

## What the plan gets right

- **The explicit new table names do not collide.**
  - `workers` and `run_leases` are distinct and purpose-specific.
  - There is no redundant “worker_status” / “worker_registry” / “run_assignments” table creep.

- **Phase 5 is right to move high-churn lease state out of `agent_runs`.**
  - Renewals are heartbeat-driven and would churn a wide hot row.
  - A dedicated `run_leases` table is the right physical shape.
  - The problem is not the table itself; the problem is leaving older owner fields alive beside it.

- **`fence_token INTEGER NOT NULL DEFAULT 0` is a good additive column shape.**
  - It preserves existing rows.
  - It avoids backfill complexity.
  - It gives stale-writer enforcement a stable default.

- **The phase-3 partial owner index is a good index design.**
  - `WHERE owner_worker_id IS NOT NULL` keeps it smaller and more targeted than a full-table index.
  - That matches the operator query surface well.

- **Phase 2 and phase 4 mostly avoid gratuitous schema churn.**
  - The plan keeps most DDL concentrated in phases 1, 3, and 5.
  - That is the right instinct for an incremental migration story.

- **The current Store stays intentionally small until there is a strong reason to expand it.**
  - Phase 1 correctly keeps worker-registry persistence behind a separate `WorkerRegistryPort` instead of bloating `Store` immediately.
  - That layering is good, even though phase 5 later needs a cleaner documented Store evolution.

- **The plan generally prefers extending existing columns over inventing new payload tables.**
  - Reusing `payload_json`, `session_id`, and `agent_runs` is sensible.
  - The only missing piece is writing down the exact serialized envelope so recovery keeps working.

- **Phase 5 correctly recognizes SQLite column-drop constraints.**
  - Even though the cited in-repo example is wrong, the instinct to use a rebuild migration rather than a naive `DROP COLUMN` is correct.

Overall: the structural ingredients are mostly sound, but the plan needs one pass that normalizes migration numbers, session authority, ownership authority, and the exact `payload_json` contract before implementation starts.
