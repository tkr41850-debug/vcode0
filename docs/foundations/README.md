# Foundations

This layer answers the three questions that have historically been hardest to
reason about in gvc0: (1) what state is the system in, (2) who triggers what
when, (3) how do coordination rules (lock/claim/suspend/resume/rebase) actually
decide what happens. Each document here is authoritative; linked
`docs/architecture/*` pages remain the detail reference. When prose and a
decision table disagree, the table wins.

## The four canonical docs

- [state-axes.md](./state-axes.md) — the three FSM axes (work, collab, run)
  plus the composite validity matrix enforced by `compositeGuard`.
- [execution-flow.md](./execution-flow.md) — who triggers what, when, across
  TUI, Orchestrator, Scheduler, Worker Pool, and the merge train.
- [coordination-rules.md](./coordination-rules.md) — decision tables for the
  lock / claim / suspend / resume / rebase / re-entry rule families.
- [newcomer.md](./newcomer.md) — one end-to-end narrative from "the user types
  a prompt" to "a commit lands on main". Start here if this is your first look.

## For detail

The foundations docs are load-bearing summaries; follow these links for the
per-topic references they distill:

- [../architecture/README.md](../architecture/README.md) — architecture topics
  (data model, graph operations, worker model, planner, persistence,
  budget/model routing).
- [../operations/README.md](../operations/README.md) — operations references
  (verification & recovery, conflict coordination, warnings, testing).
- [../reference/README.md](../reference/README.md) — TUI, knowledge/context
  inputs, codebase pointers.
- [../../ARCHITECTURE.md](../../ARCHITECTURE.md) — the top-level thesis and
  component map.

## Relationship to source

The canonical docs align with these concrete implementation anchors:

- **State axis types** — [`src/core/state/`](../../src/core/state/) and the
  axis aliases in [`src/core/fsm/index.ts`](../../src/core/fsm/index.ts)
  (`WorkControl`, `CollabControl`, `RunState`).
- **FSM guards + composite validity** —
  [`src/core/fsm/index.ts`](../../src/core/fsm/index.ts). The
  `compositeGuard` function is the executable form of the matrix in
  `state-axes.md`.
- **Exhaustive matrix test** —
  [`test/unit/core/fsm/composite-invariants.test.ts`](../../test/unit/core/fsm/composite-invariants.test.ts).
  If the matrix table and the test disagree, the test wins.
- **Warning rules** — [`src/core/warnings/`](../../src/core/warnings/). Pure
  functions with `@warns` JSDoc tags; documented in
  [`../operations/warnings.md`](../operations/warnings.md).
- **Graph invariants** —
  [`src/core/graph/validation.ts`](../../src/core/graph/validation.ts). The
  `assertAllInvariants` entry point runs every per-invariant validator.

## Conventions used in this layer

- Mermaid for state and sequence diagrams (renders natively on GitHub; plain
  text in the repo).
- Markdown tables for decision rules (reviewable in PRs; line-diffable).
- Inline markdown links for cross-references (no footnotes, no numbered refs).
- Foundation docs never duplicate detail from `docs/architecture/*`; they
  summarize and link down.
