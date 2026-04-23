# Newcomer Walkthrough: Prompt → main

This is one end-to-end story. Follow a single user prompt through gvc0 until a
commit lands on `main`. Along the way we name every module boundary the signal
crosses so you know where to look in the source tree. When you want detail,
click the inline link — this narrative never duplicates what
[../architecture/\*](../architecture/README.md) already explains.

## The prompt

The user types a prompt in the TUI and presses enter.

It might be "add a settings page", or "migrate the logger to pino", or
anything else. gvc0 doesn't care about the content yet — the prompt becomes
the seed for a **milestone**, and from there the planner agents decompose it
into **features** and then into **tasks**. Those three layers (milestone /
feature / task) are the backbone of the
[data model](../architecture/data-model.md); their typed IDs start with
`m-`, `f-`, and `t-` respectively.

## TUI accepts the prompt

The entrypoint is the [TUI](../../src/tui/) — a terminal shell built on
pi-sdk's rendering primitives. The TUI is strictly a view over orchestrator
state. It doesn't decide anything; it just translates user keypresses into
orchestrator commands and renders the current graph.

When you hit enter, the TUI posts a command to the
[App](../../src/app/) layer. App is the composition root — it holds the
orchestrator, the runtime adapter, the persistence adapter, and the TUI
together. Commands flow downward through App into the orchestrator.

## The Orchestrator takes over

The [Orchestrator](../../src/orchestrator/) owns the one thing nothing else
is allowed to own: **mutable state**. Every mutation flows through a single
serial FIFO event queue. Worker messages, feature-phase completions, and
user commands all land in the same queue and get drained one at a time.

This is deliberate. It eliminates concurrency races without locks, CAS
primitives, or transactional retries — the tradeoff is that the orchestrator
must never block on I/O inline. All I/O (git, SQLite, worker processes,
feature-phase agents) is async; the orchestrator kicks it off, then returns
to drain the next event. See [execution-flow.md](./execution-flow.md) for
the tick loop detail.

On the first prompt, the orchestrator creates a fresh milestone and feature.
The feature starts at `workControl = discussing`, `collabControl = none`.
That's a legal starting state in the
[composite validity matrix](./state-axes.md#composite-validity-matrix).

## Top-level planner drafts a feature DAG

The orchestrator sees a feature in `discussing` / `researching` / `planning`
and dispatches a **feature-phase agent** — specifically, the planner. The
[top-level planner](../architecture/planner.md) is a pi-sdk `Agent` running
with a planning prompt and access to the graph-mutation tools in
[`src/agents/`](../../src/agents/).

It reads the prompt, produces a proposed feature DAG (maybe one feature, maybe
five with dependency edges), and calls graph-mutation tools to apply those
edits. Those tool calls are proposals — they pass through the
[`proposals`](../../src/core/proposals/) validator and land on the queue as
mutations to apply.

When the planner submits, it posts a `feature_phase_complete` event. The
orchestrator picks that up on the next tick, advances the feature from
`planning` to `executing`, and transitions collab from `none` to
`branch_open`. The feature now has a long-lived git branch: something like
`feat-settings-page-f-1`.

Rule 7 of the composite guard (pre-branch phases require `collab=none`) is
why we wait to open the branch until `executing` — it keeps the branch
lifecycle aligned with the work axis.

## Serial queue → scheduler tick

Each tick, the orchestrator's [scheduler](../../src/core/scheduling/) builds
a **combined feature+task graph**, walks it twice (max-depth + longest
predecessor distance), and computes the ready **frontier**: every task
whose dependencies are done and whose feature is in `executing`.

Frontier units are sorted by
[seven priority keys](../architecture/graph-operations.md#scheduling-priority-order):
milestone queue position, work-type tier, critical path weight,
partially-failed deprioritization, reservation overlap penalty,
retry-eligibility, and age. The tier key is where the project's "prefer
completing features over starting new ones" principle lives — verify and
`ci_check` beat plain execution which beats planning which beats
summarizing.

## Feature-level planner spawns for the first feature

If the feature DAG has sub-features that themselves need task-level plans,
the feature-level planner spawns as another feature-phase agent. Its job is
narrower: read the feature's description plus any research notes, emit a task
DAG that fits on the feature branch.

This is also where typed IDs matter. A task's dependencies can only be
sibling tasks inside the same feature — cross-feature dependencies are
expressed at the feature level. The
[graph invariants](../../src/core/graph/validation.ts) enforce this: the
`assertTaskDepsAreSameFeature` validator refuses a task edge that points
across feature boundaries.

## Scheduler dispatches a ready task to the worker pool

Once the feature has a task DAG and the scheduler picks a ready task, it
builds a `SchedulableUnit { kind: "task", task, featureId }` and sends it to
the [worker pool](../../src/runtime/). The pool has a global cap on active
workers. When capacity is available, the pool spawns a new child process.

Each worker runs in its own isolated **git worktree**, branching from the
feature branch. The worktree's branch name is something like
`feat-settings-page-f-1-t-3`. Isolation is structural: a worker never sees
other workers' changes until their branches have been squash-merged.

The handoff from pool to worker is a task envelope — the task ID, the
worktree path, and the relevant context (feature description, related file
contents, previous task outputs if any). The
[worker model](../architecture/worker-model.md) document has the exact IPC
envelope shape.

## Worker sets up a worktree; pi-sdk Agent runs inside it

The worker is a child Node.js process. It sets its working directory to the
worktree, starts a pi-sdk `Agent` configured with the project's prompts, and
begins the agent loop. IPC with the orchestrator flows over stdio as NDJSON
messages.

Before every write, pi-sdk's write pre-hook fires. The pre-hook calls back
to the orchestrator via a `claim_lock` IPC message. If the path is free, the
orchestrator grants the lock; if another task in the same feature holds the
lock, the pre-hook routes the incident into the
[Lock + Suspend rules](./coordination-rules.md#lock). The worker also
enforces that writes happen inside the worktree cwd — a write outside the
worktree is a protocol violation and fails the request.

This is where the "worktree is the sandbox" guarantee comes from. Agents
cannot touch files outside their worktree, and they cannot touch files
reserved by another task in the same feature without the orchestrator
mediating.

## Commit, clean up, mark the task done

When the agent is happy with its changes, it calls `submit()`. The worker
produces a commit with a gvc0 trailer identifying the task, sends the
`submit` IPC message to the orchestrator, and waits for teardown.

The orchestrator:

1. Records the commit SHA on the task row.
2. Squash-merges the task branch into the feature branch.
3. Transitions task collab `branch_open → merged` and run-state to
   `completed`.
4. Releases any active path locks held by this task.
5. Tears down the worker process and removes the worktree.
6. Recomputes the frontier — downstream tasks become ready.

Meanwhile the TUI re-renders because its view model subscribes to the graph
changes.

## When all tasks are done, verify runs

Once the feature's task DAG is fully `merged`, the orchestrator advances
work-control `executing → ci_check → verifying`. Both of those phases are
feature-phase agent runs: `ci_check` executes the project check pipeline
(format / lint / typecheck / test) and `verify` asks an agent to review the
landed work against the feature description, returning `{ ok: true }` or
`VerifyIssue[]`.

A pass advances to `awaiting_merge`. A failure routes to `replanning` with a
typed issue list that the replanner converts into follow-up tasks. The
[verification and recovery reference](../operations/verification-and-recovery.md)
covers exactly how the issue taxonomy maps to repair vs replan.

## Merge train

`awaiting_merge` is the admission ticket to the merge queue. The
[merge-train executor](../architecture/worker-model.md) is an in-process
coordinator that spawns a dedicated integration-worker subprocess per cycle.

For our settings-page feature:

1. Collab advances `branch_open → merge_queued` when the feature enters the
   queue. (This is why Rules 5 and 6 of the composite guard forbid
   `await_response` and `await_approval` with `merge_queued`: the feature
   must not hold a merge-train slot while waiting on a human.)
2. When the merge-train head picks the feature, collab goes `merge_queued →
   integrating`. The integration-worker rebases the feature branch onto
   latest `main` and re-runs `ci_check`.
3. A clean rebase + passing `ci_check` ends with
   `git merge --force-with-lease` into `main`. Collab advances to `merged`.
4. A rebase conflict drops collab to `conflict` and steers conflict-repair
   work onto the feature branch. A verify failure during the rebase routes
   back to `replanning`. Either path eventually re-enters the queue, capped
   by the [re-entry cap](./coordination-rules.md#re-entry).

A marker row in SQLite plus a startup reconciler handle the crash window
between the `git merge` and the DB transition. If gvc0 crashes mid-merge,
the reconciler checks whether the merge SHA is visible on `main` and
advances or rolls back accordingly.

## main now has the feature's commits

After the merge lands, work-control advances `awaiting_merge → summarizing`.
The summarizing agent writes the feature's final summary (what landed, why,
where the interesting commits are) and posts `feature_phase_complete`.

That flips work to `work_complete`. The two terminals — `work = work_complete`
and `collab = merged` — line up, and the composite guard's Rule 1
(`work_complete` requires `collab = merged`) is satisfied. The feature is
done.

In budget mode, the summarizing phase is skipped and the feature
short-circuits `awaiting_merge → work_complete` directly. See the
[budget-and-model-routing reference](../architecture/budget-and-model-routing.md)
for when budget mode engages.

## Where the inbox fits

At any step along the way, an agent can call `request_help` or `propose`.
Both route the run to `await_response` / `await_approval` respectively and
post an inbox item to the TUI. The task is paused — its worker is preserved,
its worktree is preserved — but other tasks continue. When the user answers
the inbox item, the orchestrator clears the overlay and the run resumes at
`ready` or `running`. The [Resume rules](./coordination-rules.md#resume)
table enumerates every overlay and its resume trigger.

Critically, `await_response` and `await_approval` are **not** blocked on
each other. Three features can each be waiting on three different inbox
items while the other 27 features keep making progress.

## Where the user steers

The user never has to wait quietly. At any point they can:

- **Edit the DAG manually in the TUI**: drag-drop dependencies, cancel a
  feature, re-order milestones. Manual edits always win over agent proposals
  (the proposal is rejected at apply time if it conflicts).
- **Replan additively**: post a follow-up prompt that becomes a new
  milestone or feature, re-using existing work.
- **Edit config via the menu**: change budget mode, swap models per-role,
  adjust the re-entry cap.

The steering tools are documented in [../reference/tui.md](../reference/tui.md).

## What makes `main` safe

Every commit on `main` passes through the merge train, which rebases onto
the latest `main` before merging and re-runs `ci_check`. If anything fails
between rebase and merge, the feature does not land — it gets ejected back
to `branch_open` with a typed issue list. The merge-train serializes
integration, so no two features can race into `main` simultaneously. That
invariant, plus the cross-axis composite guard, plus the worktree sandbox, is
the full chain of guarantees that keeps `main` green.

## Where to go next

- [state-axes.md](./state-axes.md) — the three FSM axes and the 420-row
  validity matrix.
- [execution-flow.md](./execution-flow.md) — the scheduler tick and event
  queue mechanics.
- [coordination-rules.md](./coordination-rules.md) — the decision tables
  used above without repeating them.
- [../../ARCHITECTURE.md](../../ARCHITECTURE.md) — the top-level thesis and
  component map.
- [../architecture/README.md](../architecture/README.md) — the per-topic
  detail references.
