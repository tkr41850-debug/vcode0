# 2026-04-29 Deep-Dive Synthesis

Synthesis of five parallel deep-dive subagent investigations completed 2026-04-29, building on the [2026-04-28 landscape overview](./OVERVIEW.md) and the four [adjacent-scan subagents](./gsd-2.md) on Overstory, Factory.ai, GSD-2, and LangGraph.

Sibling pages cover each topic in detail; this page is the index plus six cross-cutting findings and ten prioritized recommendations.

## Topic pages

- [Serial vs. Parallel Evidence](./serial-vs-parallel-evidence.md) — empirical case against broad fine-grained parallelism (arXiv 2511.00872, 2512.08296, 2604.19049).
- [Durable Execution](./durable-execution.md) — Temporal / Restate / Inngest / DBOS / Earendil's `absurd`; where gvc0 sits relative to dedicated durable workflow engines.
- [Verification Architectures](./verification-architectures.md) — cross-family review evidence, SWE-Bench Verified flaws, SARIF as interop surface, how other coding agents verify.
- [AGENTS.md & AAIF](./agents-md-and-aaif.md) — Linux Foundation Agentic AI Foundation (Dec 2025) + AGENTS.md as the cross-vendor convention; implications for gvc0's CLAUDE.md-only stance.
- [Pi Ecosystem Post-Earendil](./pi-ecosystem-post-earendil.md) — Earendil as pi-sdk steward (April 2026); `gondolin` microVM sandbox; `absurd` Postgres-native workflow engine; RFC 0015 licensing.

## Six cross-cutting findings

### 1. The empirical case against broad parallelism is now strong — but gvc0's shape survives it

Two recent arXiv papers (2511.00872, 2512.08296) report that single-agent baselines beat multi-agent ensembles on coding benchmarks at sub-45% accuracy, and that coordination overhead grows super-linearly with the number of concurrent workers. The headline reads as bad news for any orchestrator that runs many agents in parallel.

The actual finding is narrower than the headline. Hierarchical decomposition (planner → workers operating on disjoint sub-problems) survives the critique; what fails is broad fine-grained parallelism where many peer agents work on overlapping context with weak coordination. gvc0's shape — feature DAG with task DAGs local to each feature, write-path locks within a feature, primary/secondary across features, serialized merge train into `main` — is the hierarchical pattern, not the broad-peer pattern.

The honest implication: gvc0 should resist the temptation to multiply task workers per feature beyond what the dependency graph actually unblocks. The papers' real lesson is "don't add parallelism past the point where coordination cost dominates," and gvc0's DAG-shape constraints already encode that discipline.

### 2. Cross-family review is empirically necessary

arXiv 2604.19049 reports that same-family LLMs share correlated blind spots, and that the correlation increases with model capability. Cross-family review (planner from one family, reviewer from another) catches roughly 16% additional issues over same-family review on the benchmark. This is a measurable, defensible architectural claim — not a stylistic preference.

For gvc0 the highest-leverage application is the **replanner**: it sees only verify failures, so its decisions are unusually load-bearing on whether the next iteration converges. Pinning the replanner to a different family than the planner is a small wiring change with disproportionate quality upside. See [cross-family-replanner.md](../feature-candidates/cross-family-replanner.md).

### 3. The Linux Foundation Agentic AI Foundation is a real standardization vector

AAIF was founded December 2025 by Anthropic + Block + OpenAI, and now stewards MCP, AGENTS.md, and goose. By April 2026, GitHub, Cursor, Cody, Aider, Claude Code, Devin, and Codex all read AGENTS.md. The convention is no longer vendor-specific signal — it's the cross-vendor coordination surface for "instructions to coding agents in this repo."

gvc0 currently respects only `CLAUDE.md`. Adding AGENTS.md interop is small and avoids a slow drift toward looking parochial relative to the rest of the ecosystem. See [agents-md-interop.md](../feature-candidates/agents-md-interop.md).

### 4. Earendil is *building* an agent ecosystem — substrate risk is lower than feared

Earendil (the public-benefit corp that took over pi-sdk stewardship in April 2026; Mario Zechner joined) is shipping `gondolin` (microVM sandbox) and `absurd` (Postgres-native durable workflow engine for Pi agents). RFC 0015 keeps `pi-agent-core` MIT permanent; new commercial products are fair-source DOSP, with server-side proprietary.

The implication for gvc0: the substrate is being actively invested in, not abandoned. The harness-boundary hedge in [claude-code-harness.md](../feature-candidates/claude-code-harness.md) remains the right insurance policy, but it's no longer urgent. See [pi-ecosystem-post-earendil.md](./pi-ecosystem-post-earendil.md).

### 5. The durable-execution conversation now includes gvc0 — and `absurd` is part of it

Temporal raised $300M at $5B in February 2026; Restate, Inngest, and DBOS all surfaced as serious alternatives in the parallel research. LangGraph's checkpointing is "between-step only" — durable on transitions, not within long tool calls. Earendil's `absurd` is Postgres-native and explicitly aimed at agent workflows.

gvc0's current model — git refs as authoritative, SQLite for derived state, NDJSON IPC — sits outside the durable-execution-engine category by choice. The git-as-state property is non-negotiable: it's what makes crash recovery work without a journal replay.

**Update (2026-04-29 follow-up):** the `absurd` evaluation is closed. Direct adoption rejected (TS SDK incompatible with process-per-task; FIFO scheduler with no DAG; pi-agent checkpointing shallower than gvc0's IPC journal; Postgres-only). What survives is pattern-borrowing — `absurd.sql` as a reference spec when gvc0 next reshapes its SQLite journal. See [absurd-evaluation.md](../feature-candidates/absurd-evaluation.md), [absurd-pattern-borrow.md](../feature-candidates/absurd-pattern-borrow.md), and [durable-execution.md](./durable-execution.md).

### 6. gvc0's moat survives the survey

Three properties remain genuinely distinctive after the deep dive:

- **Typed `VerifyIssue` + dedicated replanner agent.** No public competitor has both. Adding optional SARIF output ([sarif-verifyissue-output.md](../feature-candidates/sarif-verifyissue-output.md)) makes this interoperable without diluting the typed model.
- **Git refs as authoritative state.** Crash recovery semantics fall out of this property; competitors using purely-database state struggle to reconcile against `main`'s actual SHA.
- **Programmatic merge train.** Only Overstory shares the shape, and Overstory's queue lacks the rebase → post-rebase-CI → main-SHA validation → `merge --no-ff` invariant chain. Worth auditing Overstory's [issue #103](./merge-step-file-filtering-audit-context.md) for the analogous bug class — see [merge-step-file-filtering-audit.md](../feature-candidates/merge-step-file-filtering-audit.md).

## Ten prioritized recommendations

### Now (1–2 sprints, high ROI)

1. **Pin replanner to a different model family than the planner.** Smallest change in this list with the largest quality lever. Evidence: arXiv 2604.19049. Spec: [cross-family-replanner.md](../feature-candidates/cross-family-replanner.md).
2. **Add AGENTS.md interop alongside CLAUDE.md.** Cheap; closes a perception gap relative to the AAIF-backed convention. Spec: [agents-md-interop.md](../feature-candidates/agents-md-interop.md).
3. **Audit Overstory issue #103 (merge step file filtering) against gvc0's merge train.** Concrete bug class to verify we don't share. Spec: [merge-step-file-filtering-audit.md](../feature-candidates/merge-step-file-filtering-audit.md).

### Soon (2–4 sprints, real value)

4. **Add optional SARIF output mode for `VerifyIssue` payloads.** Interop with GitHub Code Scanning + IDE extensions. Spec: [sarif-verifyissue-output.md](../feature-candidates/sarif-verifyissue-output.md).
5. **~~Evaluate Earendil's `absurd` for orchestrator scheduling state.~~** *Done 2026-04-29.* Direct adoption rejected; pattern-borrow path tracked at [absurd-pattern-borrow.md](../feature-candidates/absurd-pattern-borrow.md). Outcome recorded in [absurd-evaluation.md](../feature-candidates/absurd-evaluation.md).
6. **Plan the harness-boundary abstraction even though `ClaudeCodeHarness` stays deferred.** Substrate hedge per [claude-code-harness.md](../feature-candidates/claude-code-harness.md). The Earendil finding lowers urgency but does not invalidate the abstraction.

### Watching brief

7. **Watch AAIF's MCP / AGENTS.md / goose stewardship cadence.** If AAIF publishes a coordination spec that overlaps with gvc0's split state model, reconsider whether to align or stay distinct.
8. **Watch `absurd`'s public release notes.** Direct adoption rejected per #5, but a v1 release introducing a SQLite mode or a published case study of a Pi-sdk DAG orchestrator integrating `absurd` would re-open the question. Until then, only the pattern-borrow path stays active.
9. **Watch Factory.ai for any coordinator state-machine specification.** Currently opaque; a public spec would change the differentiation pitch in [factory-ai.md](./factory-ai.md).
10. **Watch SWE-Bench Pro adoption.** OpenAI's February 2026 audit found 59.4% of SWE-Bench Verified problems had test-design issues. SWE-Bench Pro is the successor; if it becomes the de facto benchmark, gvc0's empirical positioning may need a fresh measurement.

## What this synthesis does not claim

- It does not claim the empirical scaling papers invalidate the merge train. The papers are about agent peer-coordination, not about CI/CD-style serialization.
- It does not claim AAIF will displace vendor conventions. The convention layer is converging; the runtime layer is not.
- It does not claim `absurd` is a drop-in replacement for SQLite. The git-refs-authoritative property is non-negotiable; `absurd` is evaluated as a complement, not a substitute.

## Revisit notes

This synthesis should be revisited:

- After SWE-Bench Pro publishes a 2026-Q2 leaderboard.
- After AAIF publishes its first coordination-layer spec.
- After Earendil ships `absurd` v1 with public API stability commitments.
- After cross-family replanner ships and we have measured ROI in `verify` failure recovery.
