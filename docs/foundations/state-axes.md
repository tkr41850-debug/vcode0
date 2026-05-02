# State Axes

gvc0 splits feature state across three axes instead of collapsing them into
one enum:

- **work control** — planning and execution phase progression
- **collaboration control** — branch / merge / conflict coordination
- **run state** — the per-`agent_runs` disposition (retry windows, help /
  approval waits, terminal outcomes)

This split is deliberate. A single enum would blur orthogonal concerns: a
feature can be _executing_ (work) on a _branch_open_ collab axis with an
individual run in _retry_await_ — three independent facts that each evolve on
their own timeline. The cross-axis invariants that tie them together live in
[`compositeGuard`](../../src/core/fsm/index.ts) and are enumerated below.

For the matching transition-graph narrative and entity shapes, see
[../architecture/data-model.md](../architecture/data-model.md). This document
is the canonical summary of the three axes plus the legality matrix over their
product.

## Work-control axis

```mermaid
stateDiagram-v2
    [*] --> discussing
    discussing --> researching
    researching --> planning
    planning --> executing
    executing --> ci_check
    ci_check --> verifying
    verifying --> awaiting_merge
    awaiting_merge --> summarizing
    summarizing --> work_complete
    work_complete --> [*]

    executing --> executing_repair: failure
    ci_check --> executing_repair: failure
    verifying --> executing_repair: failure
    awaiting_merge --> executing_repair: rebase/verify failure
    executing_repair --> ci_check: repair done
    executing_repair --> executing: repair done
    executing_repair --> replanning: escalate (cap reached)

    verifying --> replanning: typed issues
    replanning --> planning: re-plan
    replanning --> executing: re-plan
    replanning --> [*]: dead end (user intervention)

    awaiting_merge --> work_complete: budget-mode short-circuit
```

Notes:

- `replanning` is reachable only through repair escalation or verify failure.
  It is a transient repair state; the per-axis test
  [`work-control-axis.test.ts`](../../test/unit/core/fsm/work-control-axis.test.ts)
  covers its legal transitions. The cross-axis matrix below enumerates the ten
  "steady-state" work values and treats `replanning` as a transient repair
  exception — see the [replanning note](#replanning-note) below.
- The budget-mode short-circuit bypasses `summarizing` when the user runs in
  budget-first mode; see
  [../architecture/budget-and-model-routing.md](../architecture/budget-and-model-routing.md).
- Repair re-enters through `ci_check` to force re-validation after any code
  change, except that repairs originating in `executing` can return to
  `executing` directly to finish remaining work.

## Collab-control axis

```mermaid
stateDiagram-v2
    [*] --> none
    none --> branch_open: planning approved
    branch_open --> merge_queued: enter merge train
    merge_queued --> integrating: picked by merge-train head
    integrating --> merged: rebase + verify pass
    merged --> [*]

    integrating --> conflict: rebase or verify fail
    conflict --> branch_open: repair ejection
    conflict --> merge_queued: re-enter queue
    merge_queued --> branch_open: ejected for repair

    branch_open --> cancelled
    merge_queued --> cancelled
    conflict --> cancelled
    none --> cancelled
    cancelled --> [*]
```

Notes:

- `merged` is terminal for the happy path. `cancelled` is terminal for abort
  paths.
- `conflict` is the explicit collaboration-failure state. Ejection from
  `merge_queued` back to `branch_open` during integration repair is also
  valid (see
  [../operations/conflict-coordination.md](../operations/conflict-coordination.md)).
- Task-level collab is a separate, narrower axis (`none / branch_open /
  conflict / suspended / merged`) defined in
  [`src/core/fsm/index.ts`](../../src/core/fsm/index.ts) under
  `validateTaskCollabTransition`.

## Run-state axis

```mermaid
stateDiagram-v2
    [*] --> ready
    ready --> running
    ready --> cancelled
    running --> retry_await: transient failure
    retry_await --> ready
    retry_await --> running
    retry_await --> cancelled

    running --> await_response: request_help
    running --> await_approval: propose
    await_response --> checkpointed_await_response: hot window expires
    await_approval --> checkpointed_await_approval: hot window expires
    await_response --> ready
    await_response --> running
    await_response --> cancelled
    await_approval --> ready
    await_approval --> running
    await_approval --> cancelled
    checkpointed_await_response --> ready
    checkpointed_await_response --> running
    checkpointed_await_response --> cancelled
    checkpointed_await_approval --> ready
    checkpointed_await_approval --> running
    checkpointed_await_approval --> cancelled

    running --> completed
    running --> failed
    running --> cancelled

    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

Notes:

- The run-state axis is the type exported as
  [`AgentRunStatus`](../../src/core/types/index.ts) and aliased as `RunState`
  in [`src/core/fsm/index.ts`](../../src/core/fsm/index.ts). It lives on
  `agent_runs` rows and is independent of feature work/collab.
- The shipped values are `ready`, `running`, `retry_await`, `await_response`,
  `await_approval`, `checkpointed_await_response`,
  `checkpointed_await_approval`, `completed`, `failed`, and `cancelled`.
- `manual` is **not** a run-state value. Manual user ownership is tracked
  separately via `RunOwner` on the same row, so run-state stays focused on
  agent disposition.
- `await_response` and `await_approval` are live hot-window waits. If the wait
  outlives the hot window, it becomes `checkpointed_await_response` or
  `checkpointed_await_approval`; resolving the inbox item can then move the run
  back through `ready` or `running`.

## Composite validity matrix

The executable composite guard in
[`src/core/fsm/index.ts`](../../src/core/fsm/index.ts) checks every
(work × collab × run) combination declared by the exhaustive test in
[`test/unit/core/fsm/composite-invariants.test.ts`](../../test/unit/core/fsm/composite-invariants.test.ts).
The axis domains are:

- **work**: the ten steady-state values `discussing, researching, planning,
  executing, executing_repair, ci_check, verifying, awaiting_merge,
  summarizing, work_complete` (excluding transient `replanning`, see note
  below).
- **collab**: the seven values `none, branch_open, merge_queued, integrating,
  merged, conflict, cancelled`.
- **run**: the eight active-or-success values `ready, running, retry_await,
  await_response, await_approval, checkpointed_await_response,
  checkpointed_await_approval, completed`.

10 × 7 × 8 = 560 combinations are exercised by the exhaustive unit test. This
page documents the protected axis domains and invariant rules; the executable
matrix carries the row-by-row legal/rejected truth so docs do not duplicate 560
hand-maintained rows.

<a id="replanning-note"></a>

### Note on `replanning`

`replanning` is a WorkControl value not enumerated above. It is reachable only
through the repair-escalation or verify-failure transitions and is covered by
the per-axis test
[`work-control-axis.test.ts`](../../test/unit/core/fsm/work-control-axis.test.ts).
It is deliberately excluded from the composite matrix because:

1. The architectural snapshot in
   [ARCHITECTURE.md §Lifecycle Snapshot](../../ARCHITECTURE.md#lifecycle-snapshot)
   does not list it among the happy-path work states.
2. `replanning` is a transient "the feature is being re-planned" state with the
   same cross-axis constraints as `planning` (pre-branch phase — collab must
   be `none` or `cancelled`) except that `cancelled` also enforces the
   Rule 4 freeze. Rather than duplicate 42 rows that only restate Rule 7, the
   axis test carries the ground truth.
3. Including `replanning` would change the matrix cardinality (11 × 7 × 8 =
   616) and desynchronise the table from
   `test/unit/core/fsm/composite-invariants.test.ts`'s `WORK_VALUES`
   constant, which would cause the Phase 11 drift check to false-positive.

If a future axis tightening promotes `replanning` to a first-class composite
state, update both this table and the test's `WORK_VALUES` constant in the
same change.

### Also not enumerated: terminal run states `failed` and `cancelled`

The run-state axis includes three terminal outcomes: `completed`, `failed`,
`cancelled`. Only `completed` appears in the matrix, mirroring the test. The
`failed` and `cancelled` terminals are covered by
`compositeGuard`'s Rule 9 and the per-axis test
[`run-state-axis.test.ts`](../../test/unit/core/fsm/run-state-axis.test.ts).

## Rule summary

The nine internal rules inside `compositeGuard`, in evaluation order:

1. `work=work_complete` requires `collab=merged`.
2. `work=awaiting_merge` requires `collab ∈ {branch_open, merge_queued,
   integrating, conflict}`.
3. Active phases (`executing, executing_repair, ci_check, verifying,
   awaiting_merge, summarizing`) require `collab != none` — a branch must
   exist.
4. `collab=cancelled` freezes active work — no active phases allowed.
5. `collab=merge_queued` with `run=await_response` or
   `checkpointed_await_response` is illegal (cannot hold merge-train slot while
   waiting for human input).
6. `collab=merge_queued` with `run=await_approval` or
   `checkpointed_await_approval` is illegal (same reason).
7. Pre-branch phases (`discussing, researching, planning`) require
   `collab ∈ {none, cancelled}`.
8. Wait run states (`await_response`, `await_approval`,
   `checkpointed_await_response`, `checkpointed_await_approval`) require active
   work (illegal when `work=work_complete` or `collab ∈ {merged, cancelled}`).
9. `run ∈ {failed, cancelled}` is illegal at `work=work_complete` (those run
   values are not in the 560-case active-or-success matrix).

## Drift-check note

If this table disagrees with
[`test/unit/core/fsm/composite-invariants.test.ts`](../../test/unit/core/fsm/composite-invariants.test.ts),
**the test wins**. The canonical runtime shape is in
[`src/core/fsm/index.ts`](../../src/core/fsm/index.ts). Phase 11 protects the load-bearing doc claims with
[`test/unit/docs/drift.test.ts`](../../test/unit/docs/drift.test.ts). Any
changes to the run-state domain, checkpointed-wait transitions, or composite
domain cardinality should update the docs and drift test in the same commit.
