# Serial vs. Parallel Evidence

Snapshot taken on 2026-04-29 from public preprint materials. Evidence base for the orchestration-shape question: when does parallel multi-agent help, and when does it hurt?

## Why this page matters

The 2026 hype cycle treats "more parallel agents" as obviously better. Two recent papers push back hard with measurements. gvc0's design predates both papers but converges on what they recommend — this page documents the alignment so future scope decisions can cite empirical evidence rather than aesthetics.

## Primary sources

- **arXiv 2511.00872** — "When Multi-Agent Coordination Hurts: A Failure-Mode Taxonomy for LLM Coding Agents." Reports single-agent baselines beating multi-agent ensembles on coding benchmarks below the ~45% accuracy threshold. Coordination overhead grows super-linearly with the number of concurrent peer workers.
- **arXiv 2512.08296** — "Coordination Tax in LLM Agent Swarms." Decomposes the failure into context-divergence (peers see different sub-states), redundant work (peers re-do each other's reads), and conflict-resolution overhead (merge cost dominates after a threshold).
- **arXiv 2604.19049** — "Same-Family Blind Spots in LLM Code Review." Reports correlated review blind spots increasing with model capability; cross-family review catches roughly 16% additional issues.

## What the papers actually say

The headline reads as "multi-agent doesn't work." The actual finding is narrower:

1. **Failure mode is broad fine-grained peer parallelism.** Many peer agents working on overlapping context with weak coordination is what fails. The papers do not test hierarchical decomposition (planner → workers operating on disjoint sub-problems).
2. **The 45% threshold is a property of the underlying base model, not the orchestration shape.** Below ~45% per-task accuracy, peer coordination introduces more errors than it removes. Above the threshold, peer coordination produces gains that justify the overhead.
3. **Coordination cost is super-linear in worker count, not in problem size.** Adding workers past the point where dependency-graph parallelism unblocks them is strictly negative.

## What the papers do not say

- They do not say merge serialization fails. CI/CD-style serial integration is outside the scope.
- They do not say HITL planning fails. Plan approval is a coordination point, not a peer-coordination overhead.
- They do not say long-running task workers fail. The findings are about concurrent-peer interaction, not duration.

## How gvc0 sits relative to the evidence

gvc0's orchestration shape converges on what the evidence supports:

- **Hierarchical, not broad-peer.** Feature DAG with task DAGs local to each feature is hierarchical decomposition. Workers within a feature operate on disjoint sub-problems by design.
- **Dependency-shape constraints encode the parallelism ceiling.** Feature-only-on-feature and task-only-within-feature constraints prevent the orchestrator from spawning more concurrent peers than the graph actually unblocks.
- **Coordination is asymmetric, not peer-symmetric.** Same-feature write-path locks + cross-feature primary/secondary policy avoid the symmetric-peer pattern the papers identify as the failure mode.
- **Merge serialization is a feature, not a bug.** The merge train into `main` is precisely the CI/CD-style serialization the papers do not critique.

The honest implication is that gvc0 should resist the temptation to multiply task workers per feature beyond what the dependency graph unblocks. Adding parallelism past the unblocked-frontier is the failure pattern the papers measure.

## Where this evidence affects gvc0 decisions

- **Replanner parallelism stays at one.** A second concurrent replanner would be the broad-peer pattern the papers warn against.
- **Cross-feature coordination stays asymmetric.** Primary/secondary is the right shape; symmetric peer voting is not.
- **Cross-family review is empirically supported, not just stylistic.** arXiv 2604.19049 makes the case for pinning the replanner to a different model family than the planner. See [cross-family-replanner.md](../feature-candidates/cross-family-replanner.md).
- **"Multi-agent" framing in marketing should be deprecated.** gvc0 is a hierarchical orchestrator that happens to run agents in parallel where the graph allows; it is not a multi-agent swarm. Worth aligning the README language.

## Open questions

- **Does the 45% threshold depend on tooling?** Papers tested with stock tool surfaces. gvc0's typed `VerifyIssue` + replanner may shift the threshold. Worth measuring on SWE-Bench Pro once it stabilizes.
- **Does same-family blind-spot correlation extend to verification?** arXiv 2604.19049 measures code review specifically. Whether typed verify-failure classification shows the same pattern is untested.

## Public references

- <https://arxiv.org/abs/2511.00872>
- <https://arxiv.org/abs/2512.08296>
- <https://arxiv.org/abs/2604.19049>

## Revisit notes

Worth revisiting after:

- SWE-Bench Pro publishes a 2026-Q2 leaderboard.
- A follow-up paper measures hierarchical decomposition specifically.
- The cross-family replanner ships and we have internal data on verify-recovery rate.
