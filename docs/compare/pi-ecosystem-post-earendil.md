# Pi Ecosystem Post-Earendil

Snapshot taken on 2026-04-29. Status of the pi-sdk substrate after Earendil took over stewardship in April 2026, and what it means for gvc0's substrate-risk calculus.

## Why this page matters

gvc0 is built on `@mariozechner/pi-agent-core` (the pi-sdk). A common substrate question: "what happens if the upstream goes away?" The April 2026 Earendil transition substantially answers that question, and reshapes the harness-boundary calculus.

## What changed in April 2026

**Earendil** (a public benefit corporation) took over stewardship of the pi-sdk ecosystem. Mario Zechner (the original pi-sdk author) joined as a principal contributor. The transition was governance-only; the existing OSS code did not move.

Three concrete deliverables emerged:

1. **`gondolin`** — a microVM-based sandbox for executing agent tool calls. Aimed at hostile-input scenarios (running untrusted shell commands, processing untrusted file inputs).
2. **`absurd`** — a Postgres-native durable workflow engine for Pi agents. Step-grained durability, agent-aware semantics. Pre-1.0 public preview.
3. **RFC 0015** — a licensing framework. `pi-agent-core` stays MIT permanently. New commercial products from Earendil ship under fair-source DOSP (Delayed Open Source Publication). Server-side proprietary code is allowed for commercial offerings.

## What this means for gvc0

### The substrate is being invested in, not abandoned

The pre-Earendil concern was "if Mario stops maintaining pi-sdk, gvc0 has a substrate risk." The post-Earendil reality is the opposite: there's now a public-benefit corp with paid contributors actively expanding the surface. The substrate risk is lower than at any prior point.

### `pi-agent-core` MIT is permanent

RFC 0015 explicitly carves out `pi-agent-core` as MIT-permanent. This is the part gvc0 actually depends on. New commercial products under fair-source DOSP do not affect gvc0's licensing situation.

### `gondolin` is interesting but not urgent

gvc0's worker isolation is currently git-worktree + child-process. `gondolin` would add microVM isolation underneath, which matters for:

- Untrusted input scenarios (currently out of scope for gvc0).
- Hard-multi-tenant scenarios (also out of scope).
- Defense-in-depth against tool-execution escapes (real, but bounded by current threat model).

Worth tracking, not worth adopting yet.

### `absurd` is the most interesting deliverable

`absurd` is the one piece of the Earendil ecosystem that overlaps with gvc0's existing concerns (durable orchestrator state). The evaluation question is whether `absurd` can host the orchestrator's scheduling state without compromising the git-refs-authoritative property for graph state. See [absurd-evaluation.md](../feature-candidates/absurd-evaluation.md) and [durable-execution.md](./durable-execution.md).

## How the harness-boundary calculus shifts

Before Earendil: the [Claude Code harness](../feature-candidates/claude-code-harness.md) was an insurance policy against substrate risk. The argument was "if pi-sdk stalls, gvc0 needs a backup harness."

After Earendil: the substrate risk is lower. The harness boundary remains a good idea for portability and for users who already have Claude Code workflows, but it's no longer urgent insurance.

The recommendation in the [synthesis](./2026-04-29-deep-dive-synthesis.md): **plan the harness abstraction even though `ClaudeCodeHarness` stays deferred**. The abstraction is cheap; the implementation can wait for a concrete adoption signal.

## What Earendil has not committed to

Public materials are silent on:

- Long-term API stability for `pi-agent-core`. Fair-source DOSP applies to new products, not the existing surface, but no formal stability promise has been made.
- A roadmap for `pi-agent-core` itself (vs. the surrounding products). Reasonable to assume it stays load-bearing because Earendil's commercial products consume it, but not formally promised.
- Cross-version compatibility guarantees between `pi-agent-core` and `absurd`. They will likely co-evolve, but the contract is undocumented.

These are watch-items, not blockers.

## Mario Zechner's anti-orchestration stance

Worth flagging: Mario's public position has consistently been that "orchestration on top of LLMs is the wrong abstraction; durable workflows over agents are the right one." `absurd` is the concrete expression of that view.

This is *not* a critique of gvc0. gvc0 is already a durable-workflow-over-agents pattern (the merge train + the DAG are the workflow; the agents are activities). The disagreement, if one exists, is shape rather than philosophy: gvc0 puts the workflow in git refs + SQLite, `absurd` puts it in Postgres.

## Public references

- Earendil: <https://earendil.dev/>
- RFC 0015: <https://earendil.dev/rfcs/0015-licensing.md>
- `gondolin`: <https://earendil.dev/gondolin/>
- `absurd`: <https://earendil.dev/absurd/>
- Mario Zechner on durable agents (talk): <https://www.youtube.com/watch?v=XXXX> (placeholder — confirm before citing externally)

## Revisit notes

Worth revisiting after:

- `absurd` ships v1.
- Earendil publishes a `pi-agent-core` API stability commitment.
- A second commercial product from Earendil ships under fair-source DOSP (gives a sample size for the licensing pattern).
- gvc0 makes any harness-boundary change.
