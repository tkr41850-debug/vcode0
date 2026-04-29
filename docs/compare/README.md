# Compare

External comparisons and project-relative notes.

Use these pages when you want contrast with the broader 2026 AI-coding-agent landscape, predecessor systems, or specific competitors — rather than canonical gvc0 behavior.

## Format

Conventions for pages in this directory.

- **Adoption status at the bottom.** When a comparison page produces actionable recommendations for gvc0, track them in an `## Adoption status` section near the end of the file (after `## Key external sources` if present, before any final separator). Do not duplicate the table at the top — status is volatile metadata, not part of the synthesis, and a top-of-doc tracker buries the research itself.
- **Status vocabulary.** Use `done` (fully applied), `partial` (subset applied; note scope), `open` (not yet started), `deferred` (intentionally postponed), `rejected` (decided against; note reason). Avoid ad-hoc statuses like "adopted" or "in progress" — they drift between pages and lose comparability.
- **One row per recommendation, with commit references.** Columns: `Rec | Status | Commit | Notes`. Reference the commit SHA so reviewers can audit scope; the notes column is the place for partial-scope qualifications, follow-ups, or links to feature-candidate docs.
- **Update in place.** When status changes, edit the row rather than appending a new one or adding a "see also" line. Strikethrough in place is acceptable when a recommendation is rejected or fully replaced — see `2026-04-29-deep-dive-synthesis.md` item #5 for the pattern.
- **Cross-link to feature-candidate / concern docs when scope expands.** A rec that grows beyond a description tweak (e.g., requires a persistence migration or a new subsystem) belongs in `docs/feature-candidates/` or `docs/concerns/`; the adoption row links to it rather than re-stating the design.

## Landscape

- [Landscape Overview](./OVERVIEW.md) — broad survey across ~19 products and frameworks scored against gvc0's 11 distinguishing axes; commodity-vs-unique analysis and follow-up recommendations.
- [2026-04-29 Deep-Dive Synthesis](./2026-04-29-deep-dive-synthesis.md) — six cross-cutting findings and ten prioritized recommendations from five parallel deep-dive investigations.

## Cross-cutting research topics

- [Serial vs. Parallel Evidence](./serial-vs-parallel-evidence.md) — empirical case against broad fine-grained parallelism (arXiv 2511.00872, 2512.08296) and how gvc0's hierarchical shape survives the critique.
- [Durable Execution](./durable-execution.md) — Temporal / Restate / Inngest / DBOS / Earendil's `absurd`; where gvc0 sits relative to dedicated durable workflow engines.
- [Verification Architectures](./verification-architectures.md) — cross-family review evidence (arXiv 2604.19049), SWE-Bench Verified flaws, SARIF as interop surface, how other coding agents verify.
- [AGENTS.md and AAIF](./agents-md-and-aaif.md) — Linux Foundation Agentic AI Foundation (Dec 2025) and the cross-vendor convention for agent project instructions.
- [Pi Ecosystem Post-Earendil](./pi-ecosystem-post-earendil.md) — Earendil as pi-sdk steward (April 2026); `gondolin`, `absurd`, RFC 0015 licensing.

## Token economics

- [Tokenmaxxing](./tokenmaxxing.md) — two-axis research (max useful output per request vs. min tokens for useful output) synthesized into top-10 ranked priorities and a suggested PR sequence for gvc0.
- [Provider-Tokenmaxxing](./provider-tokenmaxxing.md) — narrower companion focused on provider-level prompt+cache techniques (Anthropic mechanics, agent-loop stability, cross-provider portability, per-request billing); top-16 ranked priorities and 10-PR sequence.
- [Work-Per-Request](./work-per-request.md) — inverse regime: prompt techniques that maximize useful work per HTTP call when call count is metered (RPD/RPM) but tokens within each call are free. Covers Gemma 4 free tier, Gemini free, GitHub Models, Cohere trial, OpenRouter `:free`. Top-10 ranked priorities, decision tree, and five templates.
- [Prompt Techniques Research](./prompt-techniques-research.md) — earlier survey of prompt techniques applicable to autonomous coding agents.

## Direct lineage

- [Comparison with gsd-2](./gsd-2.md) — direct ancestor; gvc0 is its TypeScript remake.

## Closest architectural / commercial competitors

- [Comparison with Overstory](./overstory.md) — closest architectural analogue (FIFO merge queue + 4-tier conflict resolution).
- [Comparison with Factory.ai](./factory-ai.md) — closest enterprise-commercial competitor (coordinator + specialized droids).

## Critical lenses

- [Overstory STEELMAN applied to gvc0](./overstory-steelman.md) — stress-test review scoring 12 agent-swarm critiques against gvc0's design (real answers vs. partial vs. theater).

## Pipeline / framework alternatives

- [Comparison with Wave](./wave.md) — pipeline-engine alternative.
- [Comparison with LangGraph](./langgraph.md) — only realistic migration-substrate candidate per the frameworks survey.
