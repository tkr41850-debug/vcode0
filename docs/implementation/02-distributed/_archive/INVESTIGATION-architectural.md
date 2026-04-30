# Architectural Decisions — Investigation

Five decisions extracted from `REVIEW-CONSOLIDATED.md` (critical issues #5,
#6, #7, #10, #15) and stress-tested against the actual code in `src/` and
the phase docs. Each section validates the user's leaning, surfaces
concrete pitfalls, proposes refinements, and ends with a verdict.

The five decisions interact more than the review readout suggests; the
last section ("Cross-decision interactions") names the ones that change
the wording of another section's verdict.

---

## Decision 5 — Ownership: drop `owner_worker_id` in 5.9

**Leaning (option a):** phase 3 step 3.1 introduces `agent_runs.owner_worker_id`
+ `owner_assigned_at`; phase 5 step 5.9 drops both columns; `run_leases`
becomes the sole source of truth for "who owns run X".

### Validation

The leaning holds, with three refinements that make it cleaner.

**Why a column at all in phase 3?** The phase-3 doc rejected a separate
`run_assignments` table on the grounds that ownership is 1:1 with a run
and the existing row already carries lifecycle fields. That rationale
collapses in phase 5 because `run_leases` *is* the join table they
rejected — it just shows up two phases later under a different name. So
the choice is between:

- (a) live with a transient column whose lifetime is "phase 3 → phase 5"
  and pay one column-drop migration at 5.9, or
- (b) skip the column and persist ownership through `run_leases` from
  phase 3 onward (what the counter-option in the prompt suggests).

The prompt asks me to validate (a); the answer is yes, but the *reason*
is not "a column is simpler" — by phase 5 the column is strictly worse
than the lease row. The reason (a) wins is **ordering risk**. Phase 3
needs durable ownership without the lease state machine
(`active`/`expired`/`released`), without fence-token semantics, and
without the heartbeat-renewal loop. Bolting an "ownership-only lease
record" in at phase 3 means designing two things at once: the lease
state machine and its degenerate phase-3 form. That's a recipe for
phase 3 reviewers asking "what's `state` for if there's no expiry
yet?", and phase 5 reviewers finding migration drift between phase-3
leases and phase-5 leases.

The simpler trajectory is: phase 3 ships a column (cheap, single fact,
zero state machine), phase 5 ships the lease table next to it, then
5.9 drops the column once the lease layer has soaked. That matches the
phase-by-phase shippability constraint.

**Phase 3 consumers between phases 3 and 5.** The phase-3 doc names
three direct consumers:

1. **Sticky resume** (step 3.5, `dispatch.ts`). Dispatch reads
   `run.ownerWorkerId`; if set and the unit is in `resume` mode, the
   picker passes `targetWorkerId = ownerWorkerId` into `dispatchRun`.
2. **Picker fallback** (step 3.3, `dispatch.ts:782-842` rewrite). On
   `not_dispatchable: 'unknown_worker'`, fallback to capacity-weighted
   selection. The column is the *input* to the sticky decision, not
   the picker proper, but the picker reads it indirectly via the run
   row.
3. **Operator query** (step 3.6, `Store.listRunsByOwner(workerId)` +
   the partial index `idx_agent_runs_owner_worker`). TUI panel shows
   "what is each worker doing?".

After phase 5, all three queries can be served from `run_leases` with
no new schema:

1. **Sticky resume** — phase 5's lease has `worker_id` and an `active`
   state. `SELECT worker_id FROM run_leases WHERE agent_run_id = ?
   AND state = 'active'` answers "who held this lease before the
   resume?". On orchestrator restart, the lease may already be
   `expired` (if the worker died); that is exactly when sticky-resume
   should fall through anyway. So the lease *state* is informative
   here, not awkward — `active` → try sticky; `expired`/`released` →
   fall back. The semantics line up.
2. **Picker fallback** — same as today; the input is `worker_id` from
   whichever lease is active or last-active.
3. **Operator query** — `listRunsByOwner` becomes
   `SELECT agent_run_id FROM run_leases WHERE worker_id = ? AND state
   IN ('active', ...)`. Index on `worker_id` is in step 5.1's design.

### Pitfalls discovered

**P1. "Who owned this run last?" semantics on `run_leases`.**

The lease state machine is `active → expired | released`. After
takeover, the *new* worker has the active lease; the *old* worker's
lease is expired. So the question "who owned this last?" requires a
non-trivial query: "the most recent expired lease whose
`agent_run_id` matches and `worker_id` differs from any active lease".

But this question only matters for **forensics** — debug telemetry,
ops "why did this run reroute?" panels. Phase 3's `listRunsByOwner`
asks the live question ("what is worker X running right now?"), which
is the active-only query. The forensic question should be served by
the events log (the takeover event from step 5.4 records both old and
new worker), not by a lease-table query. Phase 5 doc does not name an
events-log entry for the takeover, but it should — that closes the
forensic gap independently of the column decision.

**P2. The 1:1 PK constraint on `run_leases` precludes history.**

Step 5.1 declares `run_leases(agent_run_id PRIMARY KEY)`. That means
exactly one row per run, not one per lease. After takeover, the row
is `UPDATE`d to set `state='expired'` then immediately `UPDATE`d
again (or replaced) to grant the new worker. There is no audit trail
*in the lease table*. So even if you wanted to ask "who held this
last?", `run_leases` can't tell you — it only knows the current
holder.

This is a *good* invariant for the live decision (one row to renew,
one row to fence-check), but it makes the leaning even cleaner: the
lease table's PK shape forces "active lease" as the only sensible
question, which is exactly the question the dropped column also
answered. So the column→lease swap is semantically clean.

The forensic query goes to the events log. State this explicitly in
phase 5's doc: **`run_leases` is current-state only; lease history
lives in `events`.**

**P3. SQLite column-drop is a table rebuild, and step 5.9 understates
the implications.**

Step 5.9 says "uses the rebuild pattern from
`006_rename_feature_ci_to_ci_check.ts`". I read that migration; it's
a data rewrite (renaming an enum value via UPDATE), not a
`CREATE TABLE … AS SELECT` rebuild. The first table-rebuild migration
in this repo will be 5.9 itself. That's not a blocker — SQLite
3.35+ supports `ALTER TABLE … DROP COLUMN`, and the broader Alpine
3.34.x callout in the phase-5 background says we cannot rely on
3.35+ — so the rebuild is the correct path. But the cited prior art
is wrong, and the implementer should not start from
`006_rename_feature_ci_to_ci_check.ts` expecting a template.

This is already in REVIEW-CONSOLIDATED #24; flagging it here so the
ownership-drop migration's complexity isn't underestimated when
combined with `worker_pid` / `worker_boot_epoch` / `owner_worker_id`
/ `owner_assigned_at` all dropping in the same rebuild.

**P4. Phase 4 is the only phase between 3 and 5 that *might* read
`owner_worker_id`.**

I checked: phase 4 doc never reads `owner_worker_id` — it operates on
`agent_runs.scopeType === 'feature_phase'` rows, but the picker (which
*does* read the column) is shared via `dispatchReadyWork`. Phase 4
inherits sticky resume for free. No phase 4 step adds a *new* reader.

That means by 5.9 the column has exactly the three consumers from
phase 3, all of which have lease equivalents in phase 5. The drop is
safe in the sense that no phase 4 functionality silently relies on it.

**P5. `tasks.worker_id` is a separate baseline column.**

`src/persistence/migrations/001_init.ts:44` declares
`tasks.worker_id TEXT` (nullable). It maps to `Task.workerId?` at
`src/core/types/domain.ts:64`. `git grep -n "task.workerId\|\.workerId"`
across `src/` shows it is **set** somewhere and **read** by codecs
(`src/persistence/codecs.ts:193, 231`), but I found no orchestrator-
side reader that consumes it as a routing decision — the live owner
of a task run lives on the run row (`agent_runs.workerPid` /
`agent_runs.workerBootEpoch` today, `agent_runs.owner_worker_id`
under phase 3). `tasks.worker_id` looks like a leftover from an
earlier model.

Phase 5 step 5.9 should drop `tasks.worker_id` along with the
`agent_runs` columns. That removes one more "what's this for?"
artifact and consolidates ownership to `run_leases`. (REVIEW-
CONSOLIDATED #21 flagged this.)

### Concrete refinements

1. **Keep the leaning (drop in 5.9), but expand 5.9's scope** to drop
   four columns in the same rebuild:
   - `agent_runs.worker_pid` (legacy pid liveness)
   - `agent_runs.worker_boot_epoch` (legacy pid liveness)
   - `agent_runs.owner_worker_id` (phase 3 ownership)
   - `agent_runs.owner_assigned_at` (phase 3 ownership; never indexed,
     never queried per haiku-3 review)
   - `tasks.worker_id` (baseline leftover; no live consumer)

2. **Drop the phase-3 partial index `idx_agent_runs_owner_worker`** in
   the same rebuild migration. Replace with `idx_run_leases_worker`
   (already in step 5.1). Both indexes serve the same query
   ("rows owned by worker W"); only one is authoritative.

3. **Phase 5 step 5.9 should explicitly enumerate the post-rebuild
   `agent_runs` schema** in the migration's docstring. This is haiku-3's
   recommendation; not enumerating it leaves the reader to chase
   columns through 9 migrations + 1 rebuild. The doc's review-prompt
   point (4) already grep-checks for stale references, but the
   positive list ("here's exactly what survives") is more useful.

4. **State that `run_leases` answers only current-state queries** in
   the phase 5 doc. Forensic queries go to `events`. Without this the
   reader will eventually try to answer "who owned this run two weeks
   ago?" against `run_leases` and find the row gone or already
   replaced.

5. **Add an events-log entry for takeover** in phase 5 step 5.4. This
   replaces the column's history-tracking role for the only consumer
   that needed it (forensics).

6. **Sticky-resume picker should query the lease table, not the run
   row.** Today phase 3 step 3.5 reads `run.ownerWorkerId`. After
   phase 5 it should read `run_leases.worker_id WHERE state =
   'active'`. The phase-5 review prompt for step 5.9 should grep for
   `run.ownerWorkerId` as a forbidden post-phase-5 access pattern.
   This is the line phase 5's review prompt should add.

### Counter-option: persist ownership through `run_leases` from phase 3

The prompt's counter-option (a placeholder lease record at phase 3,
phase 5 only adds expiry/fence). I considered it; rejected. Reasons:

- Phase 3's lease would need to express "I have a worker but no
  expiry/fence yet" — degenerate state. Phase 5 then has to migrate
  every degenerate row to a real lease, which is a *data*
  migration, not just a schema migration. That's strictly harder
  than 5.9's column drop.
- Phase 3 reviewers would ask why a `state` column exists with
  only one value. Adding `state` only at phase 5 is cleaner.
- Phase 3 *does* need an FK target (`agent_run_id`) and a
  not-null `worker_id`. Both already exist on `agent_runs`. The
  column approach reuses the run row's natural FK; the lease
  approach needs a separate FK declaration that has to evolve.

The leaning is the right answer. Refinements above tighten it.

### Verdict

**Confirm leaning, refine to drop more in 5.9.** Drop
`owner_worker_id`, `owner_assigned_at`, `worker_pid`,
`worker_boot_epoch` from `agent_runs` and `worker_id` from `tasks` in
the same rebuild migration. Replace the phase-3 partial index with
the lease-table index. State explicitly that `run_leases` is current-
state only; forensic queries go to `events`, and add a takeover
event at step 5.4 to fill that gap.

---

## Decision 6 — Heartbeat plane: extend `health_ping`/`health_pong`

**Leaning:** the canonical lease-renewal carrier is the existing
`health_ping`/`health_pong` pair. Do not add a separate `heartbeat`
/`heartbeat_ack` family.

### Validation

The leaning is **wrong as stated**, but the underlying instinct (don't
have two heartbeats) is right. The right answer goes the other
direction: keep the **registry-plane** `heartbeat`/`heartbeat_ack`
proposed in phase 1 step 1.2, drop or repurpose the baseline
stdio-plane `health_ping`/`health_pong`. The reasoning:

**Fact 1.** `health_ping` / `health_pong` **does not exist in
`main` today**. I grep'd `src/` for the strings and got zero matches.
The phase-5 doc cites them as "from `01-baseline/phase-1-safety.md`
step 1.4", and the baseline plan does indeed introduce them — but
01-baseline has not yet shipped. So the leaning is talking about
extending a baseline frame that has not landed. Until it does, the
default is whatever 02-distributed picks.

**Fact 2.** Baseline phase 1's `health_ping`/`health_pong` are
**per-process stdio** frames (single-child stdio harness, the local
spawn model). They live on the `NdjsonStdioTransport`
(`src/runtime/ipc/index.ts:9-19`, the only existing impl). Their
purpose is local-machine "is the child alive?" — same scope as the
existing `child.on('exit')` (`src/runtime/harness/index.ts:247-252`),
just earlier and softer.

**Fact 3.** Distributed leases are **worker-scoped**, not run-scoped.
A worker hosts N runs (phase 3 step 3.4); the lease renewal carrier
must batch all N runs into one frame because per-run heartbeats would
N-multiply traffic for no benefit. That batching naturally lives on
the registry plane (one connection per worker), not the runtime
plane (one stdio pipe per child run).

**Fact 4.** The registry plane is **per-worker, network-transport,
WebSocket** (phase 1 D4). The runtime plane is **per-run, stdio,
NDJSON** today; phase 2 makes it network for remote runs but the
run-scope is unchanged.

So the two heartbeats are at different scopes:

| Plane | Transport | Scope | Carries |
|---|---|---|---|
| Registry (network) | WebSocket | Worker | Capacity, leases, capability |
| Runtime stdio (local) | NDJSON pipe | One run / one child | Run-state liveness |
| Runtime network (remote) | WebSocket | One run | Run-state liveness |

The leaning's logic was "we already have one heartbeat; don't add
another". The correct logic is **the local-stdio heartbeat is the
wrong scope for a worker-level lease**. Folding leases into
`health_pong` requires either:

- the stdio child to know about every lease its host worker holds —
  but the child only knows its own run; or
- a network-stdio bridge — but stdio is local-only by definition.

Neither is clean. So the registry-plane `heartbeat` (one per worker,
network) is the right carrier. Phase 5 step 5.3's prose "extends
`health_pong`" is a citation error — the file edits in step 5.3 point
at `src/runtime/harness/index.ts` and `src/runtime/worker/index.ts`,
which are the **stdio child path**, not the **network registry
path**. The whole step is targeted at the wrong file set.

This is also exactly the conclusion of REVIEW-CONSOLIDATED critical
issue #6 and theme D.

### `health_ping`/`health_pong` in the proposed shape

I checked baseline phase 1 step 1.4 (the baseline plan, not yet
landed). It introduces `health_ping`/`health_pong` for **local
process** liveness on the stdio transport. The intent is to detect a
hung child without waiting for `exit` — useful in the local model,
*orthogonal* to the network heartbeat needed for distributed leases.

After the distributed track, the local stdio path may go away
entirely (phase 4 step 4.8 retires the in-process feature-phase
agents; phase 5 step 5.9 retires pid liveness). Local-spawn task
workers persist (per the README's revised non-negotiable), and they
still use the stdio transport, so `health_ping`/`health_pong` remain
useful for **local** liveness even after phase 5. They just don't
carry leases. They are the local analogue of the network heartbeat.

### Pitfalls discovered

**P1. Frame-name collision between the two plans.**

Baseline phase 1 step 1.4 introduces `health_ping`/`health_pong`. Phase
1 step 1.2 of 02-distributed introduces `heartbeat`/`heartbeat_ack`.
Reviewers will reasonably ask "are these the same?" The answer is
no — they are at different scopes — but the names invite confusion.
REVIEW-CONSOLIDATED nit "four nearby heartbeat names" is the same
observation. The fix is a glossary table in the README; the names
themselves are fine if the table makes the scope distinction
visible.

**P2. `register` vs first heartbeat.**

The prompt asks: "if we collapse, does `register` go away (workers just
send `health_ping` first to declare existence)? Or stays as a one-time
handshake?"

`register` should stay as a separate one-shot. Reasoning:

- Registration carries **immutable-per-boot** data: capabilities,
  agent name+version, `bootEpoch`. Including this in every
  heartbeat is wasteful. Leaving it out of heartbeats means
  *something* has to carry it once on connect — that's `register`.
- Authentication runs once on the registration handshake (phase 1
  step 1.4 places the auth check before `registry.register`). If
  we fold registration into heartbeat, we either auth every
  heartbeat (cost) or skip auth on subsequent ones (security
  regression). Same answer applies as decision 7 below.
- Registration *acks* the protocol version. Heartbeats don't carry
  that — they assume a verified version. If you fold them, the
  first frame has to do double duty.

So: `register` is one-shot, declares stable identity; `heartbeat` is
recurring, carries leases. They are clearly two different kinds of
frame.

**P3. `heartbeat_ack` is currently a phantom.**

REVIEW-CONSOLIDATED nit #26 flags this: phase 1 step 1.2 invents
`heartbeat_ack`, then no later step uses it. Either delete or load it
with content. Suggestion (also REVIEW-CONSOLIDATED's): use it as the
**lease-renewal-result carrier**. Pong reports leases the worker
*claims* to hold; ack reports leases the orchestrator *agrees* the
worker holds (same set, minus any taken-over already). On ack, worker
drops any lease the orchestrator did not confirm, sends `abort` to
its own run executor for that run.

This makes the registry plane bidirectionally informative without
adding a third frame.

**P4. Worker process model: registry client and run executor.**

REVIEW-CONSOLIDATED significant #6 asks: a worker hosts N runs; the
registry client (one connection, sends heartbeats) and the run
executor (one or N children, hosts agents) may be different
processes. TOCTOU between "what does my registry client claim?" and
"what is my run executor actually doing?".

Proposed design constraint: **one-process-per-worker**. The registry
client and the run executor share an in-process atomic
`Map<agentRunId, fence>`. The heartbeat reads this map; lease grants
write to it; lease aborts (from orchestrator-side takeover) remove
from it.

State this explicitly in phase 5 step 5.3 design. Multi-process
workers are a future hardening target, not phase 5.

**P5. Frame size and validation.**

Adding `leases: Array<{agentRunId: string; fence: number}>` to
`heartbeat` grows the frame. With the 5s default heartbeat interval
from phase 1 D3 and the assumed worker concurrency cap (`maxConcurrent`
in phase 1, default unspecified — phase 3 references it), the worst
case is small: even at 16 runs per worker, the array is
~16 × 60 bytes ≈ 1 KB per pong. NDJSON line frames handle that
without issue; WebSocket frames are well below the default
`maxPayload` (`ws` default = 100 MB).

TypeBox validation: trivial extension. Just an `Array<TypeBox.Object({
agentRunId: String, fence: Integer })>` field, optional in the
base schema, required in the post-phase-5 schema once phase 5 step
5.5 flips enforcement.

**P6. Backwards compatibility with local-spawn task workers.**

After phase 4, local-spawn task workers persist (per README's revised
non-negotiable). They use the stdio runtime plane — and they have no
registry-plane connection because they're local children, not
registered remote workers.

Two options:

(a) Local-spawn workers register on their own faux registry
connection (phase 1 step 1.5 introduces `WorkerRegistryClient` for
test/worker reference; the same client could run inside the local
worker process talking to an in-process registry). They get a
`workerId`, send heartbeats, are leased uniformly with remote
workers.

(b) Local-spawn workers stay outside the lease layer; their
liveness is the existing `child.on('exit')`, which is already
*better* than network heartbeat for in-process children (no false
positives from network jitter).

(b) is simpler and more correct: the lease layer exists to detect
network-partitioned workers, which is impossible for an
orchestrator-spawned local child. But (b) creates two ownership
models in the system, and decision 5's "drop owner_worker_id" only
works if every dispatch goes through the lease layer.

Recommendation: pick (a). Local-spawn workers join the registry on
init (in-process, no socket — they share the orchestrator's process,
so they can call `registry.register(...)` directly). The heartbeat
loop is `setInterval`-based instead of network-WS-based but
otherwise identical. The lease grant happens on every dispatch, and
`child.on('exit')` becomes a fast-path lease expiry trigger
(orchestrator notices the child died → expire the lease immediately
without waiting `ttl + grace`). The lease layer treats local-spawn
as a worker that has perfect liveness signal; remote workers have
imperfect liveness signal that requires `ttl + grace`.

This unifies the model and is simpler than maintaining two ownership
paths.

### Concrete refinements

1. **Phase 5 step 5.3 retargets file edits.** Drop
   `src/runtime/harness/index.ts` and `src/runtime/worker/index.ts`
   from the file list. Add `src/runtime/registry/server.ts` (where
   the heartbeat handler lives, per phase 1 step 1.4) and
   `src/runtime/registry/client.ts` (worker-side, phase 1 step 1.5).
   The pong/ack frame schemas live in `src/runtime/registry/frames.ts`,
   not `src/runtime/contracts.ts`.

2. **Replace "extends `health_pong`" with "extends `heartbeat`"**
   throughout phase 5 step 5.3 prose, design decisions, and the crash
   matrix.

3. **`heartbeat` carries `leases: Array<{agentRunId, fence}>`** as the
   only payload extension. Existing `lastSeenAt` semantics from phase
   1 step 1.4 (orchestrator timestamps the receipt) are unchanged.

4. **`heartbeat_ack` carries `confirmedLeases: Array<agentRunId>`** —
   only the runs the orchestrator agrees the worker still owns. The
   worker self-aborts any locally-tracked lease not in this set.

5. **Add a glossary table to the 02-distributed README** listing:
   - `register` / `register_ack` / `register_reject` — connection-
     setup, one-shot, registry plane.
   - `heartbeat` / `heartbeat_ack` — recurring, registry plane,
     carries leases per phase 5.
   - `health_ping` / `health_pong` — local stdio liveness, baseline,
     does NOT carry leases. Local-spawn task workers only.

6. **Local-spawn workers register with the in-process registry** at
   phase 1 step 1.5's compose wiring. They do not open a network
   socket. Their lease lifecycle is identical to remote, but their
   "missed heartbeat" detection is short-circuited by
   `child.on('exit')`.

### Verdict

**Refine leaning to its inverse: keep registry-plane `heartbeat` /
`heartbeat_ack` (extended for leases) as canonical, treat
`health_ping`/`health_pong` as local-stdio-only liveness with no
lease semantics.** The leaning's instinct (one heartbeat) is right,
the choice of which one to keep is wrong. The registry plane is
worker-scoped, network-transport, and naturally batches multi-run
leases; the stdio plane is run-scoped and cannot.

`register` stays as a one-shot handshake — different lifecycle, auth
boundary, and content from heartbeat.

---

## Decision 7 — Reconnect handshake

**Leaning (option a):** add a `reconnect` frame variant in phase 1.
Worker volunteers held `(agentRunId, fence)` on reconnect.

### Validation

The leaning holds. The variant choice (separate `reconnect` frame vs.
folding into `register`) is the only open sub-question, and the
separate frame is cleaner.

### Threat model

**Replay attack.** An attacker connects, runs through registration
(needs the shared secret from phase 1 step 1.5), then claims
arbitrary `(agentRunId, fence)` on reconnect.

Mitigations (defense in depth):

1. **Authentication via shared secret on registration.** Phase 1
   step 1.4's `SharedSecretAuthPolicy` guards registration. Reconnect
   re-runs registration (same code path) — no auth bypass.
2. **`workerId` authenticates the *worker*, not the runs.** The
   reconnecting worker presents its `workerId`. Orchestrator looks
   up the lease; if the lease's `worker_id` matches the
   reconnecting `workerId`, and the worker's claimed `fence` is
   current, the reattach proceeds.
3. **Fence-token mismatch rejects.** If the worker claims a fence
   below the current `agent_runs.fence_token`, the orchestrator
   sends `abort` for that run. The worker does not get to keep
   working with a stale fence.
4. **`bootEpoch` distinguishes process restart from disconnect.**
   Same `bootEpoch` = same process; a reattach with same
   `bootEpoch` plus a fence that matches the lease can resume work
   without bumping the fence. Different `bootEpoch` = process
   restarted; in-memory state is gone, no resume possible — the
   orchestrator forces a fresh dispatch (lease will be expired by
   the time the new process registers anyway, because the heartbeat
   loop dies with the process).

The first three are sufficient against replay; the fourth handles a
different threat (process restart) but uses the same field so it's
worth pinning here.

**Transport security.** Phase 1 ships with bearer-token auth on a
plaintext WS connection by default; mTLS / TLS is "out of scope". A
network observer can capture the auth token. That's documented as a
weak-deployment compromise; production deployments must add TLS.
Reconnect doesn't change this risk model.

### Reconcile algorithm

When the worker reconnects (after `register` has succeeded), it sends
a `reconnect` frame:

```
{
  type: 'reconnect',
  workerId: string,
  bootEpoch: number,
  heldLeases: Array<{ agentRunId: string; fence: number }>
}
```

Orchestrator algorithm:

1. **Verify `workerId` matches the now-registered identity.** The
   worker just registered (one-shot); the reconnect rides on the
   same authenticated connection, so `workerId` is implicit. The
   field is redundant but kept for explicitness in the frame.

2. **For each `(agentRunId, fence)` in `heldLeases`:**

   a. Look up the run: `agent_runs WHERE id = agentRunId`.
      - If absent → run was garbage-collected. Orchestrator sends
        `lease_rejected` for that agentRunId; worker drops the run
        (kills its in-process executor, deletes its scratch).
        (Or: send `abort` — depends on whether the worker still has
        an executor for it. Choose `abort`; it's already in the
        protocol and forces cleanup.)
      - If present, continue.

   b. Look up the lease: `run_leases WHERE agent_run_id = agentRunId`.
      - If lease state is `active` AND `lease.worker_id = workerId`
        AND `lease.fence_token >= claimedFence`:
        **reattach succeeds.** No fence bump. Orchestrator extends
        `lease.expires_at = now + ttl` (treat reconnect as a fresh
        heartbeat). Worker keeps working.
      - If lease state is `active` AND `lease.worker_id != workerId`:
        **takeover already happened.** Orchestrator sends `abort`.
        Worker drops the run.
      - If lease state is `expired` AND lease was for this worker:
        **takeover may not have completed yet.** Orchestrator can
        either (i) accept the reattach and revive the lease (set
        state back to `active`, extend expires_at) — only if the
        sweep-and-takeover process has not already dispatched to a
        new worker; (ii) reject and send `abort`. Pick (ii) — once
        the lease is `expired`, orchestrator authority has decided
        the run is up for takeover; reviving it on reconnect creates
        a race with the takeover dispatcher.
      - If `claimedFence < current_fence`: stale fence, send `abort`
        regardless of lease state. Run was taken over and the new
        worker's first heartbeat bumped the fence. The reconnecting
        worker is a zombie.

3. **Leases the worker did NOT claim but orchestrator believes it
   holds:** treat as expired immediately (worker forgot about them =
   worker can't honor them). Bump fence, mark `state = 'expired'`,
   send `abort` for that agentRunId so the worker drops any half-
   forgotten state.

4. **Orchestrator response:** `reconnect_ack` frame with the set of
   leases successfully reattached. Same shape as `heartbeat_ack`'s
   `confirmedLeases`. Worker treats this as the authoritative
   "what you actually own".

### `bootEpoch` semantics

Phase 1 step 1.1 declares `bootEpoch` as a "monotonic per-worker
counter; incremented every time the worker starts" and a
"cache-invalidation token". REVIEW-CONSOLIDATED significant #32
points out phase 5 doesn't mention it.

Rule for reconnect:

- **Same `bootEpoch` as registration:** worker process survived the
  disconnect. In-memory lease state is intact. Reattach is normal:
  the algorithm above runs.
- **Different `bootEpoch`:** worker process restarted between
  registration and reconnect (or the registration was for a previous
  process). In-memory lease state is gone — the new process has no
  `heldLeases` to volunteer. The orchestrator should treat all
  prior leases as expired regardless of their `expires_at`: a
  restarted process cannot honor a lease it has no record of, even
  if the orchestrator's TTL hasn't fired yet.

This is the only place `bootEpoch` matters in phase 5. Document this
in the phase 5 design decisions section.

### Frame design: separate vs. folded

Three options:

- (a) Separate `reconnect` frame.
- (b) Fold into `register` with a "resume" flag.
- (c) First post-reconnect `heartbeat` carries reattach info.

I picked (a). Reasons:

- (b) overloads `register`. Registration is one-shot per
  *connection*; a reconnect creates a new connection, so the
  orchestrator does see a fresh `register` first. But a reconnect
  carries fundamentally different content (held leases + boot
  epoch comparison) and runs a fundamentally different algorithm
  (not "is this a known worker?" but "what's still valid?").
  Squashing them obscures both code paths.

- (c) is REVIEW-CONSOLIDATED's "first post-restart heartbeat carries
  reattach info" suggestion. The problem: heartbeats are recurring
  and stateless — every heartbeat carries the same `leases` array.
  If the *first* one is special (carries reattach info), every
  consumer has to know "is this the first one?" to apply different
  algorithms. Worse, a heartbeat that arrives before `register`
  completes is rejected (per phase 1 step 1.4 review prompt point
  4), so the protocol is "register, then *first* heartbeat is
  reconnect, then *subsequent* heartbeats are just renewals" — the
  first-vs-rest distinction is exactly what (a) makes explicit.

(a) is the cleanest path: registration declares identity, reconnect
declares held state, heartbeat renews. Three frames, three jobs.

### Pitfalls discovered

**P7-1. Garbage-collected runs.**

If `agent_runs` was pruned (operator action, retention policy), the
worker's claimed `agentRunId` is unknown. The orchestrator's
algorithm step 2.a covers this: send `abort`, worker drops. But
**the worker has scratch state for that run on disk** — worktree,
session cache. Need to clean it up.

The phase-3 step 3.4 design has per-run scratch keyed on
`agentRunId`. After `abort`, the worker should `rm -rf` the scratch
root. State this explicitly: orphan-scratch cleanup is part of the
`abort` handler on the worker side, not just the orchestrator side.

**P7-2. Multiple reconnects in flight.**

What if the worker disconnects, reconnects, disconnects, reconnects
all within the lease TTL? Each reconnect is independent; orchestrator
handles each via the same algorithm. The fence does not bump on
reattach (only on takeover), so a flapping worker keeps the same
fence. That's correct: a flapping worker that doesn't lose its
in-memory lease state should continue to own the run. If it crashes
hard (loses in-memory state), `bootEpoch` will differ on the next
register and the leases drop.

**P7-3. Reconnect during takeover dispatch.**

Race: worker A's lease expires; sweeper runs; orchestrator dispatches
takeover to worker B; worker A reconnects between sweep and B's first
heartbeat. The lease is `expired` but A's run might still be
"recoverable" from A's in-memory state.

The algorithm above rejects this (step 2.b case (ii)) — once the
sweep has run, A's reconnect is too late. This is intentional: B is
already inbound. Allowing A to revive the lease would create two
candidate workers competing for the same run.

The cost is that a brief "blip" by A right at the lease expiry edge
loses its work. That's the price of a clean state machine. To
mitigate, `leaseGraceMs` (phase 5 default 15s) absorbs single
missed heartbeats; the algorithm is correct only after grace.

**P7-4. Test scenarios.**

Required scenarios for phase 5 step 5.7 (orchestrator-restart) and
implicitly any reconnect tests:

1. **Clean disconnect-reconnect, same `bootEpoch`, lease still
   valid.** Lease reattaches; fence unchanged; work continues.
   (REVIEW-CONSOLIDATED's "scenario 1".)
2. **Slow reconnect, lease already expired by orchestrator.**
   Reconnect is rejected; `abort` sent; worker drops. (Implied by
   crash matrix's "network partition" row.)
3. **Worker process restart, different `bootEpoch`.** All prior
   leases dropped on the orchestrator side regardless of TTL;
   worker has no heldLeases to volunteer; clean state.
4. **Garbage-collected run.** Worker claims an `agentRunId` the
   orchestrator no longer has; `abort` sent; worker cleans
   scratch.
5. **Reconnect with stale fence.** Worker claims fence below
   current; `abort` sent; worker drops.
6. **Lease held by a different worker.** Worker A reconnects
   claiming a lease that B now owns; `abort` to A.

REVIEW-CONSOLIDATED critical #7 asks for these to be explicit.
Phase 5 step 5.7 today only covers scenarios 1 and 2 (under the
"orchestrator-only crash" / "double crash" headings); add 3-6.

### Concrete refinements

1. **Add `reconnect` and `reconnect_ack` frame variants** to phase 1
   step 1.2's `RegistryFrame` union. Schemas in
   `src/runtime/registry/frames.ts`, validation in
   `validateRegistryFrame`.

2. **Phase 1 step 1.4 server handles `reconnect`** with the algorithm
   above. Update the step's review prompt to include "reconnect with
   unknown agentRunId sends `abort` and does not pollute registry
   state".

3. **Phase 5 step 5.7 scenario list expands** to cover scenarios 3-6
   above.

4. **`bootEpoch` semantics documented** in phase 5 design decisions:
   same epoch = in-memory lease state intact; different epoch = all
   prior leases gone regardless of TTL.

5. **Worker scratch cleanup on `abort`** stated explicitly in phase
   3 step 3.4 (scratch isolation) and phase 5 step 5.6
   (worker-crash test).

### Verdict

**Confirm leaning.** Add a separate `reconnect` frame in phase 1.
The reconcile algorithm has a clean state machine (lease state ×
worker identity × fence × bootEpoch); folding into `register` or
the first heartbeat costs clarity. Document the algorithm precisely
in phase 5 step 5.7's design notes; expand the test scenarios to
cover the six cases above.

---

## Decision 10 — Port redesign: skip with TODO

**Leaning:** skip the rewrite (don't extract `WorkerDirectoryPort` /
`PlacementPort` / `RunLeaseStore`); add a TODO note to README.

### Validation

The leaning holds with a single carve-out (see refinement R10-3
below).

### What `RuntimePort` looks like end of phase 5 if we don't redesign

Today (`src/runtime/contracts.ts:232-348`), `RuntimePort` exposes:

- `dispatchRun(scope, dispatch, payload)` (`:239-244`)
- `dispatchTask(...)` (legacy task wrapper, `:245-250`)
- Steering / suspend / resume / abort families (`:251-345`)
- `idleWorkerCount(): number` (`:346`)
- `stopAll(): Promise<void>` (`:347`)
- `listPendingFeaturePhaseHelp(...)` (`:292-295`)

Phase 3 step 3.2 adds:

- `listWorkers(): readonly WorkerCapacityView[]`
- Optional 4th arg on `dispatchRun`: `{ targetWorkerId?, policyHint? }`
- New variant on `DispatchRunResult`: `not_dispatchable`

Phase 5 step 5.2 adds (via the dispatch result):

- `workerId: string` and `fence: number` on `started`/`resumed`
  variants.

Phase 5 step 5.5 adds (implicitly, since it threads through
`dispatchMetadata`):

- `expectedFence` on `Store.updateAgentRun` (debated, see decision
  10 sub-discussion in REVIEW-CONSOLIDATED).

End-state `RuntimePort` looks like (sketched):

```
interface RuntimePort {
  dispatchRun(
    scope: RunScope,
    dispatch: RuntimeDispatch,
    payload: RunPayload,
    options?: { targetWorkerId?: string; policyHint?: 'sticky' | 'capacity' },
  ): Promise<DispatchRunResult>;
  // ... existing steering/suspend/resume/abort
  listWorkers(): readonly WorkerCapacityView[];
  idleWorkerCount(): number;
  listPendingFeaturePhaseHelp(...): ...;
  stopAll(): Promise<void>;
}
```

The "smell": `listWorkers` and `targetWorkerId` are distributed-system
concepts on a port the README non-negotiable says should stay
transport-agnostic. README line 16 says these "live behind concrete
transport / registry / lease implementations" — phase 3 inlines them
on the generic port instead.

### What `Store` looks like end of phase 5

Today (`src/orchestrator/ports/index.ts:43-58`):

- `getAgentRun(id) / listAgentRuns(query) / createAgentRun(run) /
  updateAgentRun(runId, patch)`
- `listEvents / appendEvent`
- `getIntegrationState / writeIntegrationState /
  clearIntegrationState`

Phase 3 step 3.6 adds:

- `listRunsByOwner(workerId): AgentRun[]`

Phase 5 step 5.1 adds:

- `grantLease / getLease / renewLease / expireLease /
  listExpiredLeases`

Phase 5 step 5.5 amends:

- `updateAgentRun(runId, patch, options?: { expectedFence?: number })`
  (or, if haiku-1's argument wins, this stays unchanged and the
  fence check moves to `RunLeaseStore.expireLease` only).

End-state `Store` is more crowded but still coherent: it's the
SQLite-backed write surface. Smells:

- Lease methods are a different conceptual unit from agent run /
  events / integration state. They're a separate state machine
  (active/expired/released) that doesn't share concerns with the
  rest.
- `expectedFence` on the generic update method is the most
  contentious. Either it's everywhere or it's nowhere — making it
  optional invites callers to forget it.

### Is the debt compounding or linear?

I traced the question for both ports:

**`RuntimePort.listWorkers`.** The picker reads it from
`dispatch.ts`. Sticky resume reads it indirectly. Phase 4 doesn't add
new readers. Phase 5 adds the lease sweeper, which calls
`runtime.dispatchRun(..., { mode: 'resume', ... })` but does NOT call
`listWorkers` directly — the sweeper picks "any healthy worker"
through the same scheduler path. So readers of `listWorkers` are:
**phase-3 picker only**.

If a future refactor extracts `WorkerDirectoryPort.listWorkers`, the
search-and-replace surface is the picker plus its tests. That's
linear, not compounding.

**`RuntimePort.dispatchRun(..., options)`.** The optional 4th arg is
read by the LocalWorkerPool router (single switch on
`options?.targetWorkerId`). All callers that pass it are scheduler-
side; recovery-service uses sticky-resume from phase 3 step 3.5.
After phase 5 the lease sweeper passes the same option. Maybe 5-10
call sites total.

A future "extract `PlacementPort`" refactor would: introduce
`PlacementPort.choose(scope, workers): { workerId } | null`, change
the picker to call it, drop `targetWorkerId` from `dispatchRun`. The
sites change is the picker (one file) + `LocalWorkerPool.dispatchRun`
(strip the option handling) + tests. Linear.

**`Store.{grantLease, ...}`.** Lease methods are introduced together
in step 5.1; consumers are the lease sweeper (step 5.4), the lease
keeper (step 5.3), and the worker-pool grant on dispatch (step 5.2).
~3 files plus tests. Extracting `RunLeaseStore`: drop methods from
`Store`, add a new port, swap the constructor injection. Linear.

**`Store.updateAgentRun(..., expectedFence)`.** This is the only
debt that's potentially **not linear**. If `expectedFence` is added
as an optional parameter, every caller has to decide whether to
pass it. Many callers exist
(`grep updateAgentRun src/orchestrator -l` ≈ 20+ files). Adding it
optionally invites silent omission; making it required is a forced
refactor of every caller. The "either everywhere or nowhere" trap.

This is the one piece of decision 10 that genuinely benefits from a
dedicated helper now rather than later. See refinement R10-3.

### What's the rough effort estimate for a future "extract dedicated ports" refactor?

Counting source files only (not tests):

- `WorkerDirectoryPort` extraction: 4-6 files (port def, picker,
  recovery-service, sweeper, worker-pool, compose). Maybe 1 day.
- `PlacementPort` extraction: 5-7 files (port def, picker rewrite to
  use it, LocalWorkerPool router, recovery-service sticky, sweeper,
  compose). Maybe 1-2 days.
- `RunLeaseStore` extraction: 4-5 files (port def, sqlite impl,
  worker-pool grant site, sweeper, lease-keeper, compose). Maybe
  1 day.

Total: 2-4 days of focused refactor. **Days, not weeks.** Linear in
caller count, not exponential. The cost of paying the debt later is
bounded.

The cost of paying it now (in 02-distributed) is comparable but adds
schedule risk to phases 3 and 5 and increases reviewer load. The
arithmetic favors deferring — especially because the right port
shape is easier to see *after* the lease/picker code exists than
before.

### Sanity check: is there one specific port extension that's *especially* bad?

Yes, exactly one: **`Store.updateAgentRun(runId, patch,
options?: { expectedFence?: number })`**.

The rest are linear: callers exist, refactor is search-and-replace,
deferring is fine.

`expectedFence` on `updateAgentRun` is different. It's a **silent-
omission hazard**: any new caller introduced after phase 5 might
forget to pass it, and there's no compile-time check (it's optional).
A returning-zombie worker that triggers a write through such a
caller would corrupt state — exactly what fence tokens exist to
prevent.

The fix is not "add it to the generic method" but "route fence-
checked writes through a dedicated helper that **requires** the
fence". haiku-1's recommendation in REVIEW-CONSOLIDATED's
disagreement section. Possible shape:

```
interface RunLeaseStore {
  // existing lease methods
  updateRunWithFence(
    runId: string,
    expectedFence: number,
    patch: AgentRunPatch,
  ): { ok: true } | { ok: false; reason: 'fence_mismatch' };
}
```

`Store.updateAgentRun` stays as-is for non-worker-attributable writes
(scheduler internal state transitions, recovery, etc.). Worker-
attributable writes go through `RunLeaseStore.updateRunWithFence`,
which performs the fence check transactionally.

This is the one port-shape decision worth pinning down **inside**
phase 5, not deferring. The other extensions can stay on the generic
ports and be cleaned up later.

### README phrasing for the TODO

A draft that's specific enough to be actionable but doesn't undermine
the plan:

> **Note on transport-port purity.** The README non-negotiable
> ("`RuntimePort` and `Store` stay transport-agnostic") is observed
> only **partially** in phases 3 and 5. Specifically, `RuntimePort`
> grows `listWorkers()` and an optional `targetWorkerId` arg on
> `dispatchRun`, and `Store` grows lease lifecycle methods
> (`grantLease` / `renewLease` / `expireLease` / `listExpiredLeases`
> / `getLease` / `listRunsByOwner`). These are accepted debt: the
> distributed concepts they introduce are bounded, used by a small
> set of callers, and refactorable to dedicated ports
> (`WorkerDirectoryPort`, `PlacementPort`, `RunLeaseStore`) in 2-4
> days of focused work. The refactor is not part of this track.
>
> One specific extension is **not** deferred:
> `Store.updateAgentRun(..., { expectedFence?: number })` is
> rejected. Worker-attributable writes that need fence checking
> instead go through `RunLeaseStore.updateRunWithFence(runId,
> expectedFence, patch)`, introduced in phase 5 step 5.5 alongside
> the IPC frame fence enforcement. This avoids the silent-omission
> hazard of an optional fence parameter on a generic write method.

### Pitfalls discovered

**P10-1. README says ports stay clean; phases 3+5 don't comply.**

REVIEW-CONSOLIDATED critical #10. Already addressed: the README
phrasing above states the partial compliance explicitly, names what
deviates, and notes the refactor budget. The non-negotiable becomes
"end-state intent with a phased exception" — same shape as the
"no agents on orchestrator" non-negotiable that the README revision
already adopted.

**P10-2. Compounding debt around `dispatchRun` signature.**

If phase 4 adds a 5th arg, and a future hardening track adds a 6th,
the signature gets unwieldy. Lock the shape now: 4 args (scope,
dispatch, payload, options) where `options` is an open-ended record
that can grow without breaking callers. This is already how phase 3
step 3.2 designs it.

**P10-3. The `updateAgentRun` carve-out matters.**

This is the one port-redesign work that should land inside phase 5,
not deferred. Carve it out explicitly: introduce `RunLeaseStore` (or
fence-aware helpers on existing concrete classes) for the fence-
checked writes; leave the rest of the deferred refactor for later.
This is an exception to the "skip the rewrite" leaning, narrowly
scoped.

### Concrete refinements

1. **Skip the broad refactor.** No `WorkerDirectoryPort`,
   `PlacementPort`, or full `RunLeaseStore` extraction in
   02-distributed. Acknowledged debt.

2. **Carve out fence-checked writes.** Phase 5 step 5.5 introduces
   `updateRunWithFence(runId, expectedFence, patch)` — either as a
   method on a new lightweight `RunLeaseStore` type, or as a free
   function in `src/persistence/sqlite-store.ts` that wraps
   `updateAgentRunTxn`. Not as an optional parameter on
   `Store.updateAgentRun`.

3. **README addendum** with the phrasing above. Place it in the
   "Architectural non-negotiables" section of
   `02-distributed/README.md` as an explicit "compliance is partial;
   here's what deviates" note. Cite phase 3 step 3.2 and phase 5
   step 5.1 as the deviation sites.

4. **Lock `dispatchRun` signature** to 4 args with an open-ended
   `options` record. Phase 3 step 3.2 already does this; just don't
   regress.

### Verdict

**Confirm leaning, with one carve-out.** Skip the broad port
extraction; document the debt in the README; lock signatures so
future growth is bounded. The one exception:
`Store.updateAgentRun(..., expectedFence)` is the wrong shape
because of silent-omission risk; introduce a dedicated fence-aware
helper in phase 5 step 5.5 instead. Everything else is linear debt,
worth 2-4 days of refactor when motivated.

---

## Decision 15 — `onExit` only on clean close

**Leaning (option a):** orderly-shutdown frame from worker before
close = clean exit (`onExit` fires, run terminates). Bare transport
close = dirty (partition or crash; leases handle reclamation, run
stays `running` until lease expires).

### Validation

The leaning holds. Refinements below tighten the state machine and
spell out the test scenarios.

### Why phase 2's current design conflicts

Phase 2 step 2.4 wires `RemoteSshHarness.onExit` to the network
transport's `onClose` event — same shape as the existing
`PiSdkHarness` wiring at `src/runtime/harness/index.ts:247-252`,
where `child.on('exit')` fires `fireExit`.

In the local-spawn model, `child.on('exit')` is reliable: the kernel
guarantees it. There is no "the child is fine but the pipe died"
case in stdio — the pipe IS the child's lifeline.

In the remote model, **transport close has multiple causes**:
- worker process clean exit → also fine, can mean run is done
- worker process crash → run is gone, need takeover
- network partition → worker is fine but unreachable, must NOT
  terminate the run on orchestrator side

Treating all three the same way (= terminate the run) is the
behavior phase 2 step 2.4 inherits. That contradicts phase 5's
partition design (worker keeps running, lease expires), as
REVIEW-CONSOLIDATED significant #15 noted.

### Frame design: orderly shutdown

**Direction:** worker → orchestrator.

**Shape:**

```
{
  type: 'worker_shutdown',
  workerId: string,
  bootEpoch: number,
  reason: 'graceful' | 'config_reload' | 'operator_drain',
  inFlightLeases: Array<{ agentRunId: string; fence: number }>,
}
```

The frame is sent before the worker closes its socket. After sending,
the worker waits for `worker_shutdown_ack` (or a short timeout, e.g.
2s) before closing. Without an ack, the orchestrator may still be
processing prior frames; the worker should drain them.

The `inFlightLeases` field lets the orchestrator immediately decide:
- For each lease the worker still holds, mark `state = 'released'`
  (not `expired`) and bump fence. `released` is a new lease state
  variant: it means "voluntary drop, no zombie risk, takeover may
  proceed without grace period". The phase-5 schema declares
  `state IN ('active', 'expired', 'released')` already — this is
  what `released` is for.
- Trigger immediate reroute via the lease sweeper (or a sibling code
  path) rather than waiting `ttl + grace`.

Reusing `result`/`error` for shutdown intent is wrong: those are
**per-run** terminal frames (`src/runtime/contracts.ts:432-447`).
Worker shutdown is a per-worker event that can affect N runs at
once; conflating it with N `error` frames mis-attributes the
event ("worker shutdown" vs "every one of my runs failed
simultaneously" — these are different in monitoring).

### State machine: the limbo state

The prompt asks: between dirty-close and lease expiry, the run is in
"limbo." How does the system surface this?

Available run statuses (`src/core/types/runs.ts:16-24`):
`ready | running | retry_await | await_response | await_approval |
completed | failed | cancelled`.

Options:

- (a) Reuse `running`. The lease state (`active` until expires, then
  `expired`) carries the limbo signal. Run row is unchanged until
  takeover, at which point it goes through `running → ready` (for
  the rerouted dispatch) or `running → cancelled` (if not
  resumable).
- (b) Add a `disconnected` (or `limbo`, or `partition_pending`)
  status. Distinct rendering, distinct query.
- (c) Reuse `retry_await`.

I picked (a). Reasons:

- The lease state machine already encodes liveness — adding a parallel
  signal on the run row is duplication.
- TUI rendering can join the run row with the lease row (the data is
  already on disk after phase 5 step 5.1) and show "running, last
  heartbeat 23s ago" or "running, lease expired, reroute pending".
- `retry_await` has different semantics (retry counter, exponential
  backoff timer), reuse would muddle that vocabulary.
- `disconnected` adds a new status that every consumer of run status
  has to handle, and it's transient — the run goes through
  `running → disconnected → running` (after takeover) or `running →
  disconnected → cancelled` (if not resumable). That's worse than
  reading the lease.

So: `run_status` stays `running` until terminal. The TUI reads the
joined view and renders distinctly.

### TUI rendering today and what it needs

I checked TUI rendering of run status:

- `src/tui/app-state.ts:153` — `runStatus === 'running' && owner ===
  'manual'` — special case for manual runs.
- `src/tui/app-composer.ts:90` — `runStatus !== 'running'` gates
  certain transitions.
- `src/tui/components/index.ts:150` — `AgentMonitorOverlay` shows
  worker/run state but I didn't dig into the render details.

There's no current "limbo" or "stranded" rendering. After phase 5,
the TUI worker panel from phase 3 step 3.6 should show:

- `running` (lease active, last heartbeat < ttl) — green / normal.
- `running` (lease active, last heartbeat in grace window, lease
  not yet expired) — yellow / "delayed".
- `running` (lease expired, takeover dispatch pending) — red / "in
  recovery".

Same `run_status`, three rendering tiers driven by lease join.
Phase 3 step 3.6's "stranded" hint (run with owner but worker absent
from `listWorkers()`) is the same idea — already in the design.

### Recovery on orchestrator restart

The prompt asks: a run in limbo when orchestrator goes down — when
orch restarts, what does it see?

After phase 5: `run_status: 'running'`, `run_leases.state: 'active'`
(assuming TTL hasn't fired during downtime). Three sub-cases:

1. **Orchestrator restart fast (< ttl).** Lease still active.
   Worker reconnects to fresh orchestrator (decision 7 reconnect
   handshake). Orchestrator's `recoverOrphanedRuns` reads run as
   `running`, lease as `active` → no-op. Wait for reconnect to
   complete.
2. **Orchestrator restart slow (> ttl + grace).** Lease will appear
   `active` on disk because no sweeper ran. The double-crash
   scenario (REVIEW-CONSOLIDATED phase 5 step 5.7 case 2). Phase 5
   step 5.4 mandates `sweep-on-boot` runs *before* the scheduler
   tick. The sweeper compares `expires_at` to `now` and marks
   stale leases `expired`. Then takeover proceeds.
3. **Worker dead during orchestrator restart.** Lease will time
   out; sweep-on-boot cleans up. Identical to case 2 from
   orchestrator's view.

The orch should NOT sweep immediately for case 1 — that would race
the worker's reconnect handshake. The fix: phase 5 step 5.4's sweep
*only* expires leases whose `expires_at + graceMs < now`. So during
case 1, the lease's `expires_at` is still in the future, sweep is a
no-op, and the reconnect handshake (decision 7) completes first.

This means the sweep-on-boot ordering is correct as long as
`graceMs` ≥ orchestrator restart time. Default `graceMs` is 15s;
orchestrator restart should fit comfortably. Document this in phase
5 step 5.4: the `graceMs` parameter doubles as a "max acceptable
orchestrator restart time before runs go through takeover instead
of reattach".

### Race: clean shutdown frame in flight

The prompt asks: clean shutdown frame arrives, then transport closes
immediately after. The frame might be in flight when transport is
torn down.

Two sub-scenarios:

- **Worker sends `worker_shutdown`, orchestrator receives it,
  orchestrator sends `worker_shutdown_ack`, worker closes.**
  Clean. Both sides know. The lease is `released` immediately;
  takeover has no grace delay.

- **Worker sends `worker_shutdown`, transport closes before
  orchestrator processes it.** The frame may be lost. Orchestrator
  sees a bare transport close — treats as dirty (per the leaning).
  Lease takes the full `ttl + graceMs` to time out. Worker had
  good intent but the orchestrator can't know.

For the second case, "lost shutdown" is not a correctness issue: the
lease layer handles the cleanup, just slower. So the protocol is
**fire-and-forget on the worker side, ack-as-optimization** — if
the ack arrives, the worker can drop its lease state immediately;
if it doesn't, the worker exits anyway (it's shutting down).

REVIEW-CONSOLIDATED suggests a "sequence number" per frame for
ordering. That's overkill here. The shutdown frame is the *last*
frame the worker sends; sequence number adds nothing. Fire-and-
forget with optional ack is sufficient.

### Phase 4 proposal frame ordering interaction

REVIEW-CONSOLIDATED significant #13 wants `seq` on `proposal_op` and
`proposal_submitted` for reconnect-ordering. That's a separate
concern: the proposal stream needs ordering across a *reconnect*
(worker keeps running, but the connection drops mid-stream). It's
not the same as worker shutdown.

Propose: phase 4 step 4.5 adds `seq: number` to `proposal_op` and
`proposal_submitted`. Orchestrator-side adapter records last-seen
`seq` per `agentRunId`; on reconnect, sends `proposal_op_resync`
that asks the worker to replay from the last-seen seq. This is
orthogonal to decision 15 but worth pinning since both touch
"what frames cross the network seam".

### Pitfalls discovered

**P15-1. `worker_shutdown` carrying lease state must be fenced.**

Per decision 6's heartbeat-extension reasoning, `worker_shutdown`'s
`inFlightLeases` carries fences. Stale fences (worker's view of fence
< orchestrator's) → orchestrator ignores those entries (they were
already taken over). Per-frame fence enforcement from phase 5 step
5.5 covers this — `worker_shutdown` should be in the fenced set.

**P15-2. `worker_shutdown` is on the registry plane, not the runtime
plane.**

Following decision 6's clean separation: shutdown is per-worker,
recurring? No — one-shot per worker. But it's worker-scoped, so it
rides on the registry connection, not on a per-run runtime
connection. Otherwise the worker has to send N shutdown messages
(one per run) on N connections.

Place `worker_shutdown` and `worker_shutdown_ack` in the
`RegistryFrame` union from phase 1 step 1.2.

**P15-3. Local-spawn workers and shutdown.**

Per decision 6, local-spawn workers register on an in-process
registry. Their "shutdown" is `child.on('exit')` — already
deterministic; `worker_shutdown` doesn't apply. The state machine
should distinguish:

- Local-spawn child exits cleanly (code 0) → `result` already
  arrived; lease released.
- Local-spawn child exits with crash (code != 0 or signal) → no
  `result` arrived; lease expires immediately (no need for
  network grace) → run goes to takeover.

Phase 5's lease layer should special-case local-spawn workers:
`child.on('exit')` from a local worker is treated as a hard signal
that the lease is released (clean) or expired (crash). No TTL wait
needed because there's no partition possibility.

**P15-4. State machine ambiguity at "ack timeout".**

Worker sends `worker_shutdown`, waits 2s for ack, doesn't get one,
closes anyway. Orchestrator might have received the shutdown but
been too busy to ack. Or the ack might be in flight when the
worker closes. Or the network is dropping.

Fail open on the worker side: close the connection regardless of
ack. The lease will still time out cleanly; the worker has
exited; no cleanup is missed. The 2s wait is purely an
optimization.

**P15-5. Shutdown during takeover.**

Worker A's lease expires; orchestrator dispatches takeover to B; A
sends `worker_shutdown` while B is starting up. Orchestrator
receives both signals: sweep-driven takeover for A, and A's
voluntary release.

Resolution: orchestrator processes them in order received. If
sweep took the lease first, A's `worker_shutdown` for that
agentRunId is a no-op (lease is already expired or about-to-be).
If A's `worker_shutdown` arrives first, the takeover dispatch
sees `state = 'released'` instead of `expired` and proceeds the
same way. Either order yields a correct end state.

### Test scenarios

Required tests for phase 5 (or phase 2 if phase 2 is moved into
distributed-aware territory):

1. **Graceful worker shutdown.** Worker sends `worker_shutdown`,
   orchestrator acks, worker closes. Assert: lease state goes to
   `released` immediately; takeover dispatched without grace
   period; `worker_shutdown_ack` was sent and received before
   worker closed.

2. **Worker crash mid-run.** Worker process killed; transport
   closes uncleanly. Assert: lease state stays `active` until
   `expires_at + graceMs`; sweep marks `expired`; takeover
   dispatched.

3. **Network partition, worker keeps running.** Transport closes
   from orchestrator side; worker continues running, retains
   in-memory lease state. Assert: orchestrator-side lease times
   out; takeover proceeds. After heal, worker's reconnect carries
   stale fence → `abort`.

4. **Orchestrator restart with live partition.** Orchestrator goes
   down; before it comes back, network partitions. Orchestrator
   restarts, runs sweep-on-boot. Assert: stale leases marked
   `expired`; takeover dispatches; reconnecting worker (post-heal)
   gets `abort`.

5. **Shutdown frame lost.** Worker sends `worker_shutdown`; frame
   is dropped (network); worker closes anyway. Assert:
   orchestrator-side lease times out via TTL+grace as if dirty
   close; takeover proceeds. (This proves the "fire-and-forget"
   property: lost shutdown is not a correctness issue.)

6. **Shutdown during takeover race.** Worker A's lease at
   `expires_at`, A sends `worker_shutdown`, sweeper fires
   simultaneously. Assert: end state is consistent regardless of
   which arrives first; only one takeover dispatch happens.

REVIEW-CONSOLIDATED phase-5 step 5.7 + 5.8 cover scenarios 2, 3, 4.
Add 1, 5, 6 explicitly.

### Concrete refinements

1. **Phase 2 step 2.4 update:** `RemoteSshHarness.onExit` does NOT
   fire on bare transport close. Bare transport close is logged but
   does not produce a terminal frame on the orchestrator side; the
   run's `runStatus` stays `running`. The lease layer (phase 5)
   handles cleanup via TTL.

2. **Phase 5 step 5.X (new step or extend 5.3):** introduce
   `worker_shutdown` and `worker_shutdown_ack` registry frames.
   Define semantics: voluntary release, lease state goes to
   `released`, takeover proceeds without grace. Fire-and-forget
   with optional ack.

3. **Phase 5 step 5.1 schema clarification:** document `released`
   lease state as "voluntary worker drop, takeover may proceed
   without `graceMs` delay". The CHECK constraint already permits
   it; the doc just needs to explain when it's set.

4. **Phase 5 lease sweeper:** `expireLease` paths are
   - `expired`: sweep observed `expires_at + graceMs < now`.
   - `released`: worker sent `worker_shutdown`.
   Both lead to takeover; the difference is grace period.

5. **TUI rendering:** phase 3 step 3.6 worker panel reads the
   joined run+lease view to render limbo states. Three tiers:
   `running` + `lease active and fresh`, `running` + `lease in
   grace`, `running` + `lease expired or released`.

6. **Local-spawn special case:** `child.on('exit')` for local-spawn
   workers triggers immediate lease release (clean exit code) or
   expiry (crash exit). No TTL wait. State this in the lease
   sweeper design.

7. **`worker_shutdown` carries `fence` for each lease entry**;
   phase 5 step 5.5 includes it in the fenced-frame list.

### Verdict

**Confirm leaning.** Bare transport close is dirty; the lease layer
handles it. A new `worker_shutdown` registry frame carries
voluntary-release intent; lease state goes to `released`; takeover
proceeds without grace. `onExit` semantics are decoupled from
transport close in the remote case; the local-spawn case is
unchanged because `child.on('exit')` is deterministic. Refinements
above pin frame placement (registry plane), local-spawn special
case, and the test scenario list.

---

## Cross-decision interactions

The five decisions are not independent. Three pairs interact in ways
worth pinning down:

### Decision 6 ↔ Decision 7

The reconnect handshake from decision 7 is **on the registry plane**
because that's where worker identity lives. Decision 6 establishes
the registry plane as canonical for worker-scoped frames. So the
`reconnect` frame goes in the same `RegistryFrame` union as
`register` and `heartbeat` — no new plane, no new transport. Both
decisions resolve on the same wire surface.

If decision 6 had gone the other way (keep stdio `health_pong` as
canonical, abandon registry plane), decision 7 would have had no
clean home for the reconnect handshake — stdio is per-child, but
reconnect is per-worker. So decision 6 going registry-plane is a
prerequisite for decision 7 going clean-frame.

### Decision 7 ↔ Decision 15

The `worker_shutdown` frame from decision 15 is the **inverse** of
the `reconnect` frame from decision 7. Reconnect: worker volunteers
"I still hold these leases". Shutdown: worker volunteers "I'm
releasing these leases". Both are registry-plane, both carry
`Array<{agentRunId, fence}>`, both go through fence enforcement
(phase 5 step 5.5).

State this symmetry in the protocol doc: registry-plane frames split
into setup (`register`, `register_ack`, `register_reject`),
liveness (`heartbeat`, `heartbeat_ack`), and lease-lifecycle
(`reconnect`, `reconnect_ack`, `worker_shutdown`,
`worker_shutdown_ack`). One coherent family.

### Decision 5 ↔ Decision 10

If decision 10 had gone "extract `RunLeaseStore`", decision 5's
phase-3 column would have been a candidate for being inside the
lease store from day one — and the column drop in 5.9 wouldn't have
been needed. The "linear debt" framing of decision 10 holds because
decision 5 already commits to a column-then-drop trajectory; if
decision 5 had committed to leases-from-phase-3 (the rejected
counter-option), decision 10 would have had to extract
`RunLeaseStore` early too, because the lease layer would be load-
bearing in phase 3.

The interaction direction: decision 5 going "column then drop"
**makes** decision 10's deferral viable. Switching decision 5 to
"leases from phase 3" would force decision 10 to extract a port
before the phase-3 column work could land — pulling the port
refactor onto the critical path.

This is the single biggest cross-decision interaction. The user's
leanings on 5 and 10 are mutually reinforcing.

### Decision 6 ↔ Decision 5

Decision 6's local-spawn-as-registry-worker proposal (refinement R6
above) means local-spawn workers also have `workerId` and lease
rows. Decision 5 says ownership lives in `run_leases.worker_id`.
For local-spawn workers, `worker_id = 'local'` (or some stable
local id). That works as long as the picker treats `'local'` like
any other worker — which phase 3 step 3.2 already does
(`LocalWorkerPool` registers as `workerId = 'local'`).

So decision 6's unified-registry decision plays cleanly with
decision 5's drop-the-column decision: every worker, local or
remote, owns runs through the same `run_leases` table.

### Decision 15 ↔ Decision 5

Decision 15's `released` lease state is one of the three states in
the `state` column declared at phase 5 step 5.1. Decision 5 says
the lease table is current-state-only. The `released` state is
intentionally short-lived: it's set briefly between
`worker_shutdown` and the takeover dispatch, then the row is
overwritten by the next worker's `active` lease.

For forensics, the takeover event needs to record both the prior
state (`expired` or `released`) and the new worker. State this in
phase 5 step 5.4's events-log entry design.

### Decision 6 ↔ Decision 10

Decision 6 going registry-plane means lease state is queried via
`registryClient` / `WorkerRegistryPort`-shaped operations, *not*
via `Store.{grantLease, ...}`. That makes decision 10's "skip
`RunLeaseStore` extraction" slightly weaker — there's already a
distributed-system port (the registry) that could naturally absorb
some lease lifecycle. But decision 10's argument (linear debt,
small caller count, defer is fine) still holds. The interaction is
just that the registry port is a *better* eventual home for lease
methods than `Store`, which is one more reason the deferred
refactor will likely land.

---

## Open questions for the user

The investigation is mostly conclusive. These are the only items
that genuinely need user input rather than a recommendation:

1. **Local-spawn workers in the unified registry — confirm.** Decision
   6 refinement R6 proposes that local-spawn task workers register on
   an in-process registry and own runs through `run_leases` like
   remote workers. The alternative is a two-track ownership model
   (local-spawn uses `child.on('exit')` only; remote uses leases).
   Unifying simplifies the system but adds in-process-registration
   plumbing. **Pick one.**

2. **`worker_shutdown` fits in phase 1 or phase 5.** Decision 15
   needs the frame; the cleanest place for it is **phase 1 step
   1.2** (where the `RegistryFrame` family lives) with semantics
   "no-op pre-phase-5; on phase 5, releases leases". Alternative:
   defer to phase 5 step 5.X. Phase 1 keeps the registry frames
   together; phase 5 keeps lease-aware frames together. **Pick
   one.** Recommendation: phase 1 (one place to look up wire
   shapes).

3. **Lease state for orchestrator restart edge.** Decision 15
   discussion settles on "graceMs ≥ orchestrator restart time" as
   the design constraint that makes sweep-on-boot work cleanly.
   Default `graceMs` is 15s. Confirm 15s is enough for
   orchestrator restart in production deployments, or bump the
   default.

4. **Sweep-on-boot synchronousness.** REVIEW-CONSOLIDATED
   significant #7 already flags this. Phase 5 step 5.4 currently
   says "start the sweeper interval inside `scheduler.run()`".
   Decision 15's analysis confirms it must be:
   ```
   await sweeper.sweep(now);  // synchronous, before any tick
   scheduler.tick();
   setInterval(sweeper.sweep, intervalMs);
   ```
   **Confirm this is the correct ordering** before phase 5 step
   5.4 lands.

---

## Recommended next-step actions

Concrete edits to apply across the phase docs, in dependency order:

- **README phase-end-invariants pass** (decision 10 R10-3): rephrase
  the "transport-agnostic ports" non-negotiable as "end-state intent
  with phase-3/phase-5 deviations enumerated". Cite the deviations.
  Add the TODO note from R10-3.

- **README "wire planes" glossary table** (decision 6 R5; covers
  REVIEW-CONSOLIDATED nit re: four heartbeat names): list `register`
  / `register_ack` / `register_reject` (setup), `heartbeat` /
  `heartbeat_ack` (registry liveness, distributed leases),
  `health_ping` / `health_pong` (local stdio, no leases),
  `reconnect` / `reconnect_ack` (registry, lease-lifecycle),
  `worker_shutdown` / `worker_shutdown_ack` (registry, lease-
  lifecycle).

- **Phase 1 step 1.2 frame additions** (decisions 6, 7, 15): add
  `reconnect` / `reconnect_ack` / `worker_shutdown` /
  `worker_shutdown_ack` to the `RegistryFrame` union. Remove
  `heartbeat_ack` if the empty form is kept; otherwise extend it
  per decision 6 R3 to carry `confirmedLeases`.

- **Phase 1 step 1.4 server algorithm**: handle `reconnect`
  per decision 7's algorithm (lease lookup + fence check + state
  decision); handle `worker_shutdown` per decision 15 (release
  leases + ack + close).

- **Phase 1 step 1.5 wiring** (decision 6 P6): local-spawn
  workers register on the in-process registry; `child.on('exit')`
  fast-paths to lease release/expiry per decision 15 R6.

- **Phase 3 step 3.5 sticky-resume query** (decision 5 R5):
  rewrite to query `run_leases` instead of `agent_runs.owner_worker_id`
  after phase 5 lands. Phase 3 itself uses the column; phase 5
  step 5.9 grep-checks for `run.ownerWorkerId` reads as a
  forbidden post-phase-5 access pattern.

- **Phase 3 step 3.6 TUI panel** (decision 15 R5): worker panel
  joins run + lease for limbo rendering — three tiers for
  `running` × lease state.

- **Phase 5 step 5.1 lease state docs** (decision 15 R3, R4):
  document `released` semantics and the three sources of
  takeover (sweep on `expired`, worker on `released`, local
  child exit on `released`/`expired`).

- **Phase 5 step 5.3 retarget** (decision 6 R1, R2, R4): replace
  every "extends `health_pong`" with "extends `heartbeat`".
  Drop `src/runtime/harness/index.ts` and `src/runtime/worker/index.ts`
  from file edits; add `src/runtime/registry/server.ts` and
  `src/runtime/registry/client.ts`. Heartbeat schema gets
  `leases: Array<{agentRunId, fence}>`.

- **Phase 5 step 5.4 sweep semantics** (decision 15 R4, open
  question 4): synchronous sweep-on-boot before scheduler.tick;
  expire vs. release distinction in the sweeper.

- **Phase 5 step 5.5 fenced frames list** (decisions 7 P1, 15 P15-1):
  add `worker_shutdown`, `reconnect` to the fenced-frames list along
  with the proposal frames already enumerated in
  REVIEW-CONSOLIDATED.

- **Phase 5 step 5.5 fence-checked write helper** (decision 10
  R2): introduce `RunLeaseStore.updateRunWithFence(runId,
  expectedFence, patch)` (or a free function in
  `sqlite-store.ts`). Do **not** add `expectedFence` to
  `Store.updateAgentRun`.

- **Phase 5 step 5.7 scenario expansion** (decision 7 P7-4,
  decision 15 test scenarios): explicitly enumerate the 6
  reconnect scenarios and the 6 shutdown/limbo scenarios as
  test requirements.

- **Phase 5 step 5.9 column drops** (decision 5): drop
  `agent_runs.{worker_pid, worker_boot_epoch, owner_worker_id,
  owner_assigned_at}` and `tasks.worker_id` in one rebuild
  migration. Drop `idx_agent_runs_owner_worker`. Replace
  citation of `006_rename_feature_ci_to_ci_check.ts` with a
  note that this is the first table-rebuild migration in the
  repo. Enumerate the post-rebuild `agent_runs` schema.

- **Phase 5 step 5.4 takeover events** (decision 5 P1, decision
  15 R3): emit an `events` row on every takeover and every
  voluntary release, with old worker, new worker, prior lease
  state, and reason. This becomes the forensic record that
  `run_leases`'s current-state-only PK shape cannot keep.

- **Phase 4 step 4.5 proposal stream `seq`** (cross-decision,
  REVIEW-CONSOLIDATED significant #13): not in scope here but
  worth pinning since decision 7's reconnect algorithm assumes
  it. Add `seq: number` to `proposal_op` and `proposal_submitted`;
  define `proposal_op_resync` for reconnect replay.
