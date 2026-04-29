# Tokenmaxxing — Maximizing Useful Output per Request and per Token

External research on 2025–2026 LLM token economics applied to gvc0. Two complementary lenses:

- **Q1 — request-priced regime.** A provider that bills per request with no upper bound on output length. How do you pack the most useful, dense, non-degenerate signal into a single response without it collapsing into padding, repetition, or hallucinated filler?
- **Q2 — token-priced regime.** Standard per-token billing. How do you maximize useful output per token across input, output, and reasoning budgets?

Both lenses apply to gvc0 simultaneously: the planner could in principle benefit from a Q1-style "thorough single shot," while the entire system needs Q2 discipline because token cost scales linearly with task volume.

## Method

Two rounds of Sonnet subagents with web search.

- **Round 1 (discovery, 1 agent).** Mapped the 2025–2026 landscape — prompt caching, extended thinking, long-context vs. RAG, prompt compression, output formats, model routing, batch inference, semantic caching, Skeleton-of-Thought, Chain of Density, output degeneration. Surfaced 11 deep-dive topics across both questions.
- **Round 2 (4 parallel agents).** Each took a coherent cluster, read primary sources directly, and applied findings to gvc0's architecture.
  - **Cluster A** — prompt caching, reasoning token budgets, agent context engineering (Q2-leaning)
  - **Cluster B** — output structure, prompt compression, model routing (Q2)
  - **Cluster C** — Skeleton-of-Thought, Chain of Density, output degeneration mitigations (Q1)
  - **Cluster D** — RAG vs. long-context, batch inference, semantic caching (Q2)

This document is the consolidated synthesis. Sources cited inline; full reference list at the end.

---

## Cross-cluster findings

**1. The Q2 stack has matured into a tiered architecture.** Production systems now compose: SHA/exact-match cache → prompt caching → reasoning budgets → context engineering → output format → prompt compression → model routing → batch inference. Each tier targets a different failure mode and different cost driver. The interactions matter: composing them naively creates conflicts (compression busts caching prefix stability; downtiering with compression crosses the smaller-model capability floor).

**2. Q1 is structural commitment + density, not raw verbosity.** The naïve framing "more tokens means more useful output" is wrong. The dominant 2025–2026 finding is that without deliberate structure, long outputs degrade through three failure modes: repetition loops (~15% of production agent requests in one case study), hallucinated filler that expands length without adding signal, and topic drift. Solutions are almost entirely prompt-side. Skeleton-of-Thought and Chain of Density together provide the canonical Q1 toolkit.

**3. Prompt caching is the single highest-leverage Q2 lever.** Anthropic's 90% read discount (with 25% write surcharge, breaking even at 1.4 reads/write) compounds with batch inference (50% off) for a ~95% reduction on cached prefix tokens. The "Don't Break the Cache" paper (arXiv:2601.06007, January 2026) measured 4% hit rates without architectural discipline vs. 59% cost reduction with proper static-first layout — making cache layout a first-class engineering concern, not an afterthought.

**4. Tool result tokens are the dominant agent cost driver.** SWE-bench analysis shows 30,400 of 48,400 total tokens came from tool results alone; 39.9–59.7% of those tokens were removable with no performance loss. For gvc0's worker debugging loops this is the single highest-ROI context reduction because no model inference is required to truncate.

**5. Context drift, not exhaustion, is the dominant agent failure mode.** ~65% of 2025 enterprise agent failures were attributed to context drift, not running out of context window. Anchored iterative summarization at 70% utilization beats full reconstruction (4.04 vs. 3.74 accuracy) because regenerating from scratch loses specifics. Vocabulary preservation (exact tool names, file paths verbatim) is essential.

**6. Long-context vs. RAG cost gap is 1250x; quality gap is real and unresolved.** Long-context at 100k tokens is ~$0.20 input; equivalent RAG ~$0.00008. Most models *peak* at 16–64k tokens and degrade past that — Claude 3.x-Sonnet drops 27% from 16k to 125k on Databricks benchmarks. "Lost in the Middle" U-curve confirmed unrebutted on multi-fact retrieval through 2026. Hybrid self-routing (skeleton + JIT tool-call retrieval) is the production-ready answer.

**7. TOON marketing is overstated; TSV is the strongest baseline.** TOON's claimed 30–60% token reduction has a documented 0% accuracy on truncation detection (disqualifying for task lists), 0% on deep nesting, and a "prompt tax" that for smaller models causes TOON to consume *more* tokens than JSON. Pipe-delimited TSV captures most of the savings without the failure modes.

**8. Constrained decoding is a hazard for frontier models.** Hermes-4-405B dropped from 92.5% to 35.0% with grammar constraints applied. Anthropic's tool-use schema validation already provides 99%+ schema reliability — adding another grammar layer is dangerous. The "think in natural language, format at the end via tool call" pattern is already gvc0's architecture and should be preserved.

**9. Reasoning budgets need adaptive control.** Extended thinking inflates costs 2–5x but pays off only for multi-step sequential problems where errors compound. For classification, extraction, retrieval, and routing tasks, CoT can *hurt* accuracy (17.2% drop on Gemini Pro 1.5 in one benchmark). The TALE/BudgetThinker work shows ~41% of reasoning tokens can be eliminated with no accuracy loss via task-adaptive budgets.

**10. Routing is high-leverage but degrades silently.** Enterprise deployments report 30–88% cost reduction. The clearest failure mode is silent quality degradation: a Haiku completing a "trivial" task that is actually moderate produces code passing self-checks but failing at integration. The capability floor for plan/decomposition tasks is high — never route plan to cheap models.

---

## Top 10 unified priorities for gvc0 (ranked by ROI)

Deduplicated and synthesized across all four clusters. Higher items have stronger evidence and higher leverage. Suggested PR sequence at the bottom.

**1. Cache-partition the worker system prompt.** Worker is gvc0's highest-volume call site. `EXECUTE_TASK_PROMPT` (static across all calls) and feature-level fields (stable within a feature) get `cache_control: ephemeral` breakpoints; per-task content stays in the dynamic tail. Verify pi-sdk's `Agent` accepts `ContentBlock[]` for systemPrompt; if string-only, push cache markers into the model bridge layer. Expected: 40–70% input token cost reduction on worker calls. *Files:* `src/runtime/worker/system-prompt.ts`, `src/agents/runtime.ts`, model bridge.

**2. Route all planner feature-phase calls through the Anthropic Batch API.** `discuss`, `research`, `plan`, `verify`, `summarize` are all latency-tolerant — they serialize before tasks start. 50% off, stacks with #1 to ~95% off the cached prefix. Replanner stays on real-time API. Persist `batchId`; poll for completion; handle the 24-hour expiry as retriable. Critical: HTTP 200 on submit doesn't mean processed — verify result counts before marking phase complete. *Files:* feature-phase orchestrator, persistence schema, model bridge.

**3. Cap tool result tokens at 2,000 per result.** SWE-bench data shows 39.9–59.7% of agent input tokens removable from tool output alone. Bash output: keep first/last 20 lines (preserves error + stack trace). File reads: explicit offset/limit beyond ~1,500 tokens. Pure harness-level filter, no prompt changes. *Files:* `src/runtime/worker/` tool execution layer or pi-sdk adapter.

**4. Wire `task.weight` to `taskRoutingTier()`.** One-line change in `src/orchestrator/scheduler/dispatch.ts:363–365`: trivial→light, small/medium→standard, heavy→heavy. With `light: claude-haiku-3-5`, trivial+small tasks (likely 40–60% of dispatches) route to Haiku. Existing `escalateOnFailure` is the safety net. Expected: 40–50% task-execution model cost reduction. *Files:* `src/orchestrator/scheduler/dispatch.ts`, `ModelRouter` test assertions.

**5. Reorder `proposalSubmitSchema` so `summary` is last; add skeleton-commitment + density-check + anti-padding instructions to PLANNING_DOCTRINE.** This is the bundled planner Q1 blueprint (C1+C2+C3). Five-line schema fix prevents premature commitment. ~25 lines of prompt additions enforce structural commitment before tool calls and density per `addTask`. *Files:* `src/agents/tools/schemas.ts`, `src/agents/prompts/plan.ts`.

**6. Enable extended thinking for plan/replan only.** `budget_tokens: 8000`. Disable for execute. Plan/replan match the multi-step-sequential profile where thinking pays 11–13% accuracy gains; worker tool loops match the single-hop profile where it costs without gain. Wire `budgetPressure` in `ModelRoutingConfig` to tighten budgets under load. *Files:* `src/agents/runtime.ts` (`phaseRoutingTier` extension), `FeaturePhaseOrchestrator.createAgent`.

**7. Tiered context for the research phase + ordering discipline for the U-curve.** Tree-sitter export skeleton at primacy (~1500 tokens), full reads via tool call. Move `outcomeVerification` to position 1 in `buildSystemPrompt`. Flip `discussionSummary`/`researchSummary` order in `renderPlanningPrompt` (research is higher signal). Zero-cost ordering changes; skeleton requires `node-tree-sitter` + TypeScript grammar as preprocessing. *Files:* `src/agents/prompts/research.ts`, `src/agents/prompts/plan.ts`, `src/runtime/worker/system-prompt.ts`.

**8. SHA-keyed file-summary cache in SQLite.** New table `file_summary_cache(file_path TEXT, git_sha TEXT, summary TEXT, ..., PRIMARY KEY (file_path, git_sha))`. Exact-match cache (no false-positive risk), invalidates automatically on commit. Population cost is negligible if generated by Haiku batch calls. Hit rates near 100% across project lifetime for stable infra files. *Files:* new SQLite migration in `src/persistence/`, hook into `read_file` tool path.

**9. Anchored iterative compaction at 70% context utilization.** Preserve last 6 turns verbatim; compress older turns with vocabulary-preserving prompt (exact tool names, file paths, error messages verbatim). Trigger before `agent.continue()` in `FeaturePhaseOrchestrator`. Test the crash-recovery path before enabling — compacted sessions must replay correctly. *Files:* new `src/runtime/context/compaction.ts`, `src/agents/runtime.ts` `executeAgent`.

**10. Surface cache hit rate + reasoning token ratio in the TUI.** `TokenUsageAggregate` already has `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`. Without observability, the other optimizations are blind: a hit rate <40% on workers signals a busted prefix; reasoning ratio >3x output on plan/replan signals budget overspend. Prerequisite for #1, #2, #6. *Files:* `@tui/*` view models + per-task aggregation in `@runtime/usage.ts`.

### Suggested PR sequence

- **PR1 (observability + low-risk wins):** #10 (TUI metrics) + #3 (tool result truncation) + schema reorder portion of #5.
- **PR2 (caching, biggest single lever):** #1 (cache-partitioning) once pi-sdk capability confirmed.
- **PR3 (batch infrastructure):** #2 (Batch API for planner) — biggest impact, biggest implementation surface.
- **PR4 (routing):** #4 (`task.weight` wiring) + extended thinking for plan/replan (#6).
- **PR5 (context engineering):** #7 (tiered research context + U-curve ordering) + #8 (SHA-keyed file cache).
- **PR6 (deeper Q1 + drift prevention):** prompt portion of #5 (planner skeleton + density) + #9 (compaction).

---

## Cluster A — Prompt caching, reasoning budgets, agent context engineering

### A1. Prompt caching for agentic workloads (Q2)

#### Findings

Anthropic's prompt caching charges a 25% write surcharge but reads back at $0.30/M vs. $3.00/M for fresh input — a 90% discount on cache hits. The break-even point is just **1.4 cache reads per write**, meaning a static prefix that reappears on the second call already pays for the write overhead. The January 2026 "Don't Break the Cache" paper (arXiv:2601.06007) evaluated 500+ agentic sessions with 10,000-token system prompts and measured cost reductions of 41–80% and time-to-first-token improvements of 13–31% across providers.

The paper identified a sharp anti-pattern: "naive full-context caching" with dynamic content embedded in the prefix paradoxically *increases* latency because it causes cache misses on every turn while still paying write costs. Teams without intentional cache warm-up achieved only ~4% hit rates in agentic workloads; those that enforced static-first layout reached 59% cost reduction.

The structural rule is well-established: **the cacheable prefix must be exactly bit-for-bit identical across calls**. Anything dynamic (timestamps, request IDs, session-specific content, task descriptions, variably-formatted summaries) must land *after* the last `cache_control: ephemeral` breakpoint. Anthropic's API supports up to four cache breakpoints per request, each requiring a minimum of 1,024 tokens (2,048 for Haiku). The 5-minute TTL refreshes on use; between tasks, the 5-minute window is the failure point. Parallel task spawning is a specific hazard: simultaneous cold-start against the same uncached prefix means every process pays the write cost, but only the first actually populates the cache (race condition in the KV cache warming window).

#### gvc0 application

- **Cache-partition the worker system prompt.** In `@runtime/worker/system-prompt.ts`, `buildSystemPrompt` currently returns a flat string. Restructure to return an array of content blocks. Apply `cache_control: { type: "ephemeral" }` at two boundaries: (1) after `EXECUTE_TASK_PROMPT` alone (static across all tasks/features/runs); (2) after the feature-level sections (`featureObjective`, `featureDoD`) which are stable across all tasks in the same feature. Per-task sections (`renderTaskSection`, `objective`, `scope`, `dependencyOutputs`) form the uncached tail. Expected hit rate: near 100% for block 1; 60–80% on planner re-invocations within the same feature.
- **Cache-partition the planner/replanner prompts.** `PLANNING_DOCTRINE` in `@agents/prompts/plan.ts` is identical for plan and replan and changes only on doctrine updates. `renderPlanningPrompt` should separate doctrine from feature-context content so the API call layer can set a cache breakpoint between them.
- **Freeze tool definition ordering and text.** Tool definitions passed to `Agent` must be byte-stable across calls. Audit `@agents/tools/agent-toolset.ts` and `@agents/tools/planner-toolset.ts`; segregate static tools from any feature-parameterized ones and place a breakpoint after the static list.
- **Stagger parallel task spawns with a small jitter.** Add a per-worker stagger (~500ms based on queue position) at dispatch in `@runtime/worker-pool.ts` so the first worker populates the cache before subsequent workers read it.
- **Track cache-hit metrics in the TUI.** Surface `cacheReadTokens / (cacheReadTokens + inputTokens)` per phase. <40% on workers signals busted prefix.

#### Risks and gotchas

- pi-sdk's `Agent` may only accept `systemPrompt: string`. If so, cache_control markers require dropping to the raw Anthropic SDK call level. Verify the contract first.
- Doctrine changes bust the cache across all in-flight tasks. Hot-patching prompt constants during an active run is dangerous.
- Feature field updates mid-execution (via `editFeature`) bust block 2 if those fields live in the cached layer. Design the boundary so mutation-prone fields stay in the dynamic tail.
- 4-breakpoint API limit. Two breakpoints leave headroom; counting matters if tool definitions are added as a third block.

---

### A2. Reasoning token budgets — when extended thinking pays off (Q1/Q2)

#### Findings

Direct answers use 15–30 tokens; chain-of-thought uses 150–400; full extended thinking can reach 5–10x output token overhead. The 2026 token economics analysis quantifies: **41% of reasoning tokens can be eliminated on average without any accuracy loss**, and a 17.2% accuracy *drop* was observed on Gemini Pro 1.5 when CoT was applied to classification tasks the model answers correctly without it.

The regime boundary is clearer than often stated: extended thinking helps for tasks with (a) multi-step sequential dependency where each step constrains the next, (b) no ground-truth retrieval shortcut, (c) output quality that compounds across the reasoning chain. It hurts or is neutral for: classification, extraction, routing, single-hop retrieval, and well-structured sequential tasks where the model already has the answer in weights.

The TALE paper (arXiv:2412.18547) introduced Token-Budget-Aware Reasoning, which dynamically adjusts reasoning depth based on problem complexity. BudgetThinker (arXiv:2508.17196) approaches the same problem via control tokens inserted during inference. Both confirm: **fixed maximum budgets are wasteful; task-adaptive budgets are the right operating point**. Chain-of-Draft achieves comparable accuracy with 7.6–32% of full CoT's tokens.

#### gvc0 application

- **Enable extended thinking for `plan` and `replan` only.** In `FeaturePhaseOrchestrator.createAgent`, when `phase === 'plan' || phase === 'replan'`, inject `thinking: { type: 'enabled', budget_tokens: 8000 }`. Plan phases are multi-step-sequential where decomposition errors compound — the profile that shows 11–13% accuracy improvement.
- **Wire `budgetPressure` flag to tighten budgets under load.** `ModelRoutingConfig` already has the field. When concurrency is high, reduce `budget_tokens` by 50% or disable thinking entirely. Scheduler can set this based on queue depth.
- **Disable extended thinking for worker `execute` phase.** Worker tool-calling loops are single-hop retrievals/actions. Explicitly pass `thinking: { type: 'disabled' }` if the ceiling model defaults to thinking mode.
- **Track reasoning token usage per phase.** `TokenUsageAggregate` already has `reasoningTokens`. Target operating point: roughly equal to output tokens for plan/replan. Above 3x output: budget too loose. Near zero on hard features: thinking isn't activating.
- **Apply Chain-of-Draft style instructions for `discuss` and `research`.** Adding "Respond with structured sections only, no verbose reasoning; bullet points for all findings" reduces output tokens without degrading the summary quality plan depends on.

#### Risks and gotchas

- Extended thinking has tool-use compatibility constraints; verify proposal tool patterns work in thinking mode.
- Thinking token cost is unbounded without a ceiling. Always set explicit `budget_tokens`.
- Plan quality regression is silent — if thinking is disabled and quality drops, the signal is indirect (downstream replan frequency, task failure rate). Instrument plan quality metrics before/after the change.

---

### A3. Agent context engineering — rolling compression and drift prevention (Q1/Q2)

#### Findings

The headline number from enterprise deployment data: **65% of agent failures in 2025 were caused by context drift, not exhaustion**. Drift occurs when the agent's reasoning diverges from original intent despite available context — attention de-prioritizes older content, compression rewording shifts framing, tool outputs overwrite prior state. Qwen2.5-7B drops 45.5% F1 over a 10% context-length increment near 43% of its window. Anthropic's engineering post defines "context rot" as the result and recommends the "minimal set of high-signal tokens" principle.

The arXiv:2603.13017 paper on structured distillation provides the most precise compression numbers: 371 tokens per conversation exchange compressed to 38 tokens (**11x compression**) across 14,340 exchanges, MRR=0.717 vs. baseline 0.745 — 96% retention of retrieval quality. The mechanism: each exchange becomes four structured fields (summary, specific context, thematic room assignments, file paths). Crucially, 96.8% vocabulary retention is achieved by having the LLM reuse participant terminology rather than paraphrase. BM25/keyword search degrades on this because lexical overlap is lost; hybrid retrieval (BM25 verbatim, HNSW distilled) is the workaround.

The SWE-bench tool-result analysis is more immediately actionable: **30,400 of 48,400 total tokens came from tool results alone, and 39.9–59.7% of those tokens were removable with no performance loss**. Tool output, not reasoning, is the dominant cost driver.

For rolling compression: anchored iterative summarization outperforms full reconstruction (4.04 vs. 3.74 accuracy on technical details). The practical trigger is 70% context utilization. Compaction preserves the last 5–7 turns verbatim, compresses the rest, never compresses the system prompt.

#### gvc0 application

- **Cap tool result tokens at 2,000 per result.** SWE-bench finding applies directly to worker tool results. For bash/test output: keep first 20 + last 20 lines (retains error + stack trace). For file reads: explicit offset/limit beyond ~1,500 tokens. Highest-ROI context reduction; no inference required.
- **Implement anchored iterative summarization for long planner sessions.** When `sessionStore.load(sessionId)` returns a message array near 70% of context, trigger summarization before `Agent.continue()`. Preserve last 6 messages verbatim; compress the rest into structured handoff blocks. Use vocabulary-preserving language ("use exact field names, tool names, file paths from the original").
- **Inject a recency-position task anchor at the bottom of the worker system prompt.** U-shaped attention curve. `outcomeVerification` is currently mid-prompt where attention is lowest; move to top, repeat at bottom as a 3-line "Task commitment" footer. Doubles attention weight without duplicating the full payload.
- **Cap each event-summary field at 500 tokens.** `buildSummaryContext` in `@agents/runtime.ts` aggregates events; `blockerSummary`, `decisions`, `followUpNotes` can grow long. Per-field budget prevents replan prompts from being dominated by prior failure history at the expense of current task state.
- **Add a phase-turn limit with forced compaction.** If a plan/replan exceeds 8 assistant messages without `submit`, inject a system-level compaction and the directive to summarize current proposal state and continue to submit. Prevents runaway planning loops.

#### Risks and gotchas

- Compaction mid-session can lose exception-path detail. Always preserve "specific context" verbatim; instruct: "If a tool call failed, include the exact error message verbatim."
- Vocabulary drift in summaries (synonyms instead of exact tool names) breaks subsequent tool resolution. Explicit instruction: preserve all tool/function names and file paths verbatim.
- Compaction interacts with crash recovery. The compacted session must replay correctly after a crash — test the resume path before enabling.

---

## Cluster B — Output structure, prompt compression, model routing

### B1. Output structure and format selection (Q2)

#### Findings

**The TSV baseline is stronger than TOON marketing implies.** Gilbertson's measurement on tabular data found JSON uses ~2x as many tokens as TSV and takes 4x as long to generate (superlinear due to JSON's recursive grammar). TSV is lowest-token across all tested formats; formatted JSON is highest. ROI breakeven for switching is ~4.5M output tokens/day at Sonnet pricing.

**TOON's accuracy advantage is narrower than claimed and has documented failure modes.** arXiv:2603.03306 found TOON works well for flat structures (90.5% one-shot on uniform user records) but **collapses on deep nesting (0% one-shot on hierarchical data)**. The "prompt tax" is the gotcha: TOON requires substantial instructional overhead, and for smaller models this overhead causes TOON to consume *more* tokens than JSON (4715 vs. 2772 for Qwen3-235B). The invoice case is the worst: 0% first-pass accuracy triggered repair loops doubling total cost (3626 vs. JSON's 1723). The toonformat.dev benchmark shows TOON at 76.4% accuracy vs. JSON's 75.0% with 39.9% fewer tokens — but **TOON scores 0% on detecting truncated arrays**, where CSV and XML hit 100%.

**Constrained decoding (JSON with FSM token masking) achieves the lowest token counts but carries a strong-model accuracy hazard.** JSO achieves 556 tokens vs. TOON's 840 vs. JSON's 1078 on uniform tabular data. Caveat: Hermes-4-405B *dropped* from 92.5% to 35.0% with constraints applied. Weaker models show the opposite: Qwen2.5-Coder-7B went from 0% failure to 75% success under constraint. Constrained decoding is a safety net for cheap models, potentially a hazard for frontier models.

**Forcing JSON during reasoning degrades accuracy 10–15%.** Recommended pipeline: free-form reasoning → constrained/schema-gated emission at the terminal `submit(...)` call. This is already gvc0's architecture.

#### gvc0 application

- The `submit(...)` / `submitX(...)` architecture is correct "think-then-format." Do not switch to constrained decoding on top of Anthropic's tool-use layer — risks the Hermes-4-405B-style accuracy drop.
- For tool result payloads returned to the agent (`listFeatureTasks`, `getTaskResult`, `getFeatureState`), switch from JSON to pipe-delimited rows. Frontier Claude reads pipe-delimited data with near-JSON accuracy. *Files:* `src/agents/tools/feature-phase-host.ts` and feature-phase tool handlers.
- In `buildSystemPrompt` (`src/runtime/worker/system-prompt.ts:94–111`), reformat `dependencyOutputs` from nested bullets to two-line TSV per dependency: `taskId | featureName | summary` on line 1, `files: path1, path2` on line 2.
- `featureDoD` and `expectedFiles` arrays rendered as Markdown lists are already near-optimal. Do not switch arrays under ~8 items to TSV; structural savings disappear at that scale.

#### Risks and gotchas

- TOON's 0% on truncation detection rules it out anywhere the agent reasons about completeness. Never use TOON for `listFeatureTasks` results.
- Schema complexity tax from constrained decoding: 20+ field schemas drop from ~78 to ~45 tokens/sec. `submitVerify` with nested `criteriaEvidence` is borderline; monitor throughput.
- Repair-loop cost multiplier: format parse failures in high-concurrency runs are proportionally expensive. Tool-use already prevents this for `submitX(...)`; ad hoc structured output in agent prose is unprotected.

---

### B2. Prompt compression (Q2)

#### Findings

**LLMLingua family numbers and scope.** LLMLingua achieves up to 20x compression with ~1.5-point accuracy loss on GSM8K/BBH. LLMLingua-2 is 3–6x faster via token classification (XLM-RoBERTa fine-tuned on GPT-4 distillation). At 14x on CoT reasoning, LLMLingua-2 achieves 77.79% vs. baseline 78.85% — 1.06-point loss. **On RAG, 5x compression *improved* accuracy from 54.1% to 74.0% (+19.9 points)** by removing retrieval noise. For summarization and conversation, safe range is 3–9x.

**Evaluator heads (NeurIPS 2025, arXiv:2501.12959) are state-of-the-art for training-free compression.** Specific attention heads function as internal relevance scorers during pre-filling, no separate model. Compression latency: 0.88s vs. LLMLingua-2's 1.27s vs. LongLLMLingua's 67.44s. Code tasks retain well (61.9 score); summarization is the relative weakness. **Limitation: requires model-internal attention access, which Anthropic's API does not expose.** LLMLingua-2 is the practical choice for gvc0.

**The accuracy cliff is task-type-specific.** Reasoning and ICL tolerate 10–20x. Dense-content tasks (multi-document QA, code) fail earlier. Extractive (token selection) outperforms abstractive (rewriting): +7.89 F1 on 2WikiMultihopQA at 4.5x extractive vs. -4.69 F1 abstractive at the same ratio. Rule: **extractive only, never abstractive**, for content the agent treats as contract.

#### gvc0 application

- Apply LLMLingua-2 at 3–4x to `dependencyOutputs.summary` fields before injecting into worker system prompts. RAG/summarization is the safe task-type sweet spot. Leave `taskId`, `featureName`, `filesChanged` verbatim. Savings scale with DAG depth — a 5-deep chain could see 60–80% reduction in dependency tokens.
- Apply 3–5x to narrative fields of `researchSummary` injected into the plan prompt (`existingBehavior`, free-text `summary`). Preserve structured arrays (`essentialFiles`, `reusePatterns`, `riskyBoundaries`) verbatim.
- Gate compression behind a token-count threshold (3000 tokens assembled prompt) and a `tokenProfile !== 'quality'` check. LLMLingua-2 adds ~1s latency; below 3000 tokens not worth it.
- Disable compression in test mode. `fauxModel` matches scripted responses to exact prompt content; non-deterministic compression breaks tests.
- **Do not compress** tool definitions, `objective`, `scope`, `outcomeVerification`, `featureObjective`, `featureDoD`. These are high-density contract fields where every token is precise.

#### Risks and gotchas

- Requires a separate deployed model (XLM-RoBERTa). No native Anthropic integration. Sidecar process adds reliability/versioning surface.
- Cascading failures across the DAG: dropping a critical detail from task A's summary causes task B to make wrong assumptions. Repair = full task replan. Be conservative on ratio for inter-task handoffs.
- Compression on tool descriptions is high-risk. A compressed `addDependency` description losing `from`/`to` semantics causes systematic planning errors.
- Safe composition rule: **do not compress input to light-tier workers**. Smaller models need more context to stay above their capability floor.

---

### B3. Model routing (Q2)

#### Findings

**Empirical range is 30–88% cost reduction.** Routing survey (arXiv:2502.00409): MixLLM achieves 97% of GPT-4 accuracy at 24% of cost; FrugalGPT 59–98% savings. ACL 2025 LLM-AT: 59.37% on MATH, 88.01% on MCQA vs. single top-tier model. **80–85% of queries resolve at the initial (cheaper) tier.**

**LLM-AT Starter/Generator/Judge architecture is the most transferable framework.** Starter estimates tier accuracy from embedding-similar historical queries. Generator runs the selected model. Judge (same-tier model) evaluates validity with binary yes/no; F1 of 0.876 vs. generator accuracy of 0.749 on MATH. Failed Judge → automatic escalation. 83.5% of MATH queries resolve at initial tier; 15.2% need one escalation; 1.3% need two.

**Routing failure modes.** Domain classifiers: 53% accuracy on out-of-distribution queries. Verbalized confidence: unreliable (overestimates). Complexity classifiers outperform domain classifiers (64.3% vs. 52.2%). Routing requires complementary skills — if the cheap model can't do the task, routing wastes latency before forced escalation.

**gvc0 already has the right routing primitive: `task.weight`.** Planner-assigned weights (trivial=1, small=4, medium=10, heavy=30) encode exactly the complexity signal that classifiers try to infer post-hoc. The infrastructure exists in `src/runtime/routing/index.ts`; `taskRoutingTier()` in `src/orchestrator/scheduler/dispatch.ts:363–365` is hardcoded to `'standard'`.

**Do not route `plan` to cheaper models.** Plan decomposition has a capability floor below which cheap models produce structurally invalid or incomplete plans. A bad plan is paid by every downstream task. Cost asymmetry severe; keep `plan` at `'heavy'`.

#### gvc0 application

- Change `taskRoutingTier()` to consume `task.weight`: trivial→light, small/medium→standard, heavy→heavy. Function needs to accept a `Task` argument; pass it from `buildTaskRunPayload` at line 349 where the task is already in scope. With `light: 'claude-haiku-3-5'`, expected 40–50% reduction in task-execution model costs.
- Add `replanScope: 'minor' | 'major'` derived from `deriveReplanReason`. Blockers and architectural mismatches are major (heavy tier); task additions, dependency adjustments, scope clarifications are minor (standard tier). Wire into `phaseRoutingTier` — currently `replan` is always heavy.
- Wire `escalateOnFailure: true` to the worker's retry count. `ModelRouter.resolveTier()` already handles this via `options.failures`; dispatch path needs to pass current retry count into `RouteModelOptions`.
- Verify `discuss`/`research` (currently standard) are not over-provisioned. Consider experimenting with light tier for features where discussion is brief.
- Add a `routingTier` override field to `editTask` schema for manual escalation without changing weight semantics.

#### Risks and gotchas

- A planner that systematically under-weights tasks routes complex work to light models. Track correlation between `routingTier=light` and `replan_needed` verify outcomes.
- Haiku completing a "trivial" task that is actually moderate produces code passing self-checks but failing verify. Invisible until verify rejects. `escalateOnFailure` only fires on retry, not on first-pass quality shortfalls.
- `fauxModel` test harness doesn't exercise routing logic. Add unit assertions: trivial-weight tasks dispatch with light-tier model; heavy-weight with heavy tier.
- `budgetPressure: true` forces all tasks to light. Should not apply to plan/replan. Add a `budgetPressureExcludePhases` config or hardcode the exclusion in `resolveTier()`.

---

## Cluster C — Maximizing useful output per request (Q1)

### C1. Skeleton-of-Thought and parallel decomposition (Q1)

#### Findings

**Core technique and numbers.** SoT (ICLR 2024, arXiv:2307.15337) generates a numbered 3–10 item skeleton first (each point 3–5 words), then expands each independently — in parallel if using the API. Across 12 LLMs: 8/12 exceed 2x speedup; Claude 1.83x; Vicuna-33B 2.69x; peak 2.39x. Quality "comparable or better in 60% of question categories" per GPT-4 judge. SoT-R adds a RoBERTa 120M router for selective fallback.

**The critical structural limit.** SoT explicitly fails on tasks with sequential dependencies: math, coding, Fermi estimation. It works when subtopics are genuinely independent. For a task DAG, this is the core tension: task N's full specification often depends on task N-1's interface. The paper flags this and directs future work toward Graph-of-Thoughts for dependency-aware decomposition.

**The Q1 reframing.** In a request-priced regime, the value of SoT is *not* latency — it is **structural commitment before elaboration**. The skeleton is a forward plan the model must fill and cannot exceed, preventing the "write until you feel done" drift pattern. Content drift and padding tasks both require the model to operate without a committed structure; SoT closes that window.

**Interaction with extended thinking.** SoT and extended thinking compose cleanly in principle — the thinking budget is spent designing the skeleton (what N points, which are sequential). No empirical study on this composition existed as of April 2026.

#### gvc0 application (planner + replanner)

- **Planner: skeleton-commitment gate.** Add to PLANNING_DOCTRINE a required fenced outline block before any `addTask` call: task name (3–5 words), one proof-value sentence, `dep:` list, `type: sequential | parallel`. "Commit to this outline. Do not add tasks during expansion." Prevents scope creep mid-expansion (primary source of padding tasks). *File:* `src/agents/prompts/plan.ts`, ~8 lines.
- **Replanner: SoT maps onto diagnosis + corrective action.** Diagnosis points (what failed, why) are genuinely independent — SoT's failure mode does not apply. Skeleton step 1: list each failure hypothesis independently. Step 2: list each corrective task. Expansion fills each with evidence and rationale.

#### Risks and gotchas

- Sequential tasks in the skeleton need in-order expansion with reference to prior task outputs — require this explicitly or inter-task descriptions will be inconsistent.
- Verbosity explosion per expansion point: pair with CoD density instructions (C2) to keep each field tight.
- Trivial features (1–2 tasks) should skip the skeleton step; add a size threshold to the instruction.

---

### C2. Chain of Density and iterative densification (Q1)

#### Findings

**Core technique and numbers.** CoD iteratively rewrites a fixed-length summary to incorporate 1–3 missing "salient entities" per round without extending length. Five rounds in the original study. **Human-preferred optimum: round 3** (61% of first-place votes). GPT-4 judge peaks on informativeness at round 4 (4.74/5), overall quality at round 4 (4.61/5); coherence peaks at round 1 (4.96/5) and declines monotonically. GPT-4 vs. human correlation: 0.31 — they optimize for different things. Practical: **3 rounds for human readability; 5 rounds for machine-judged density at coherence cost.**

**Entity definition is the portable abstraction.** The mobile app review extension (arXiv:2506.14192) achieved 11.75 entities/summary at round 5 vs. 9.50 vanilla (p<0.05) with no readability degradation, by redefining the entity as "functional or non-functional app feature users perceive as harmful or beneficial." Four required modifications: domain-specific entity definition, content filtering, length adjustment, role framing. **CoD is a template with a variable entity definition.**

**Applying CoD to plan generation.** CoD has not been validated on plan generation. The structural analogy holds: a task description is fixed-length; a "salient entity" becomes a non-obvious implementation detail, dependency rationale, or risk note; "densification" is iterative insertion without word count increase. Critical difference: CoD's "Faithful" constraint (entity must be present in source) must be replaced with "grounded in codebase evidence from the Research Summary." Without this, the density pass will hallucinate specifics.

#### gvc0 application (planner + replanner)

- **Planner — per-field density check.** Add to PLANNING_DOCTRINE after the "when planning" list: "After drafting each task, identify the single most important implementation detail or dependency rationale a worker would need to discover by reading code if it were omitted. Insert it without adding sentences — compress existing content to create space." This is 1-round CoD applied to `description` fields. *File:* `src/agents/prompts/plan.ts`, ~6 lines.
- **Planner — `outcomeVerification` density.** Same pattern: "Name the specific command, artifact, or test exit code that proves this task is done. One sentence. No weasel words."
- **Replanner — evidence densification.** For each task being removed or modified: "State the specific task result, failure message, or code observation that justifies this change." Converts vague replan rationale into machine-verifiable justification.

#### Risks and gotchas

- Cap at 1–2 density passes, not 5. Coherence degradation is real and workers need to read and execute these descriptions.
- The JSON output format CoD uses for structured iteration may suppress reasoning (arXiv:2408.02442). Allow the density pass as prose in PLANNING_DOCTRINE; the final output is committed via `addTask`.
- Without a faithfulness anchor, density instruction can hallucinate specifics. Pair with: "Ground every added detail in a specific file or pattern named in the Research Summary."

---

### C3. Output degeneration mitigations (Q1)

#### Findings

**Three complementary 2025 taxonomies.**

- **Code Copycat Conundrum (arXiv:2504.12608):** 20 patterns across three granularities (character, statement, block); five repetition types (complete, similar, finite, infinite, random) across 19 models. Root cause: code clones in pretraining corpora. DeRep (rule-based first-occurrence retention) achieves 91.3%/93.5%/79.9% improvement on rep-3/rep-line/sim-line; Pass@1 up 208.3% vs. greedy.
- **SpecRA (OpenReview):** 813 repetitive samples from 1.13M agent output records. FFT autocorrelation on vocabulary projection detects periodicity with tolerance to minor variations. Lightweight, non-intrusive; works across proprietary and open-source models.
- **Practitioner case study:** 15% request degeneration rate in production. 360 tests. `presence_penalty` tuning (0.8, 1.5, aggressive) all left degeneration at 15% or worsened it. **46% prompt reduction (110 → 59 lines) eliminated degeneration to 0%.** Root cause: numbered lists, tables, and parallel bullet structures in the system prompt induced in-context pattern-copying. Fix: natural language, explicit "state each point only once; never repeat."

**Cross-study consensus:** Prompt-side structural changes outperform decoding parameter tuning. Two causes, two mitigations: training-data-driven (code clones) needs post-generation detection (DeRep, SpecRA); prompt-structure-driven needs removing structural templates and adding anti-repetition instructions.

**Schema field ordering as degeneration mitigation.** A 2026 finding: placing answer fields before reasoning fields causes models to commit to conclusions before completing reasoning — syntactically valid but semantically degenerate. gvc0's `proposalSubmitSchema` currently places `summary` first. The planner commits to a summary before filling `decompositionRationale` and `risksTradeoffs`, so the summary can contradict the rationale. **Fix: `summary` last.**

**Topic drift** is distinct from repetition. Lilian Weng's hallucination survey (2024) confirms RLHF preference for longer answers systematically reduces factuality — models trained to produce longer outputs produce more drift. Structural output commitment (skeleton, schema, ordered fields) is the primary drift mitigation.

#### gvc0 application (planner + replanner)

- **Schema reorder.** In `proposalSubmitSchema` (`src/agents/tools/schemas.ts`): move `chosenApproach` to first field, `summary` to last. 5-line change; prevents premature commitment.
- **Anti-padding instructions.** Add to PLANNING_DOCTRINE: "Do not add tasks to demonstrate thoroughness. Every sentence in a task description must contain a specific file path, function name, or dependency rationale. If a description exceeds three sentences, remove the least specific one. Each task must do work the others cannot — state what would be left undone if it were removed."
- **Replanner progressive commitment.** Before any mutation tool call, require the replanner to emit a fenced diagnosis block (what failed, evidence, wrong assumption). Anchors corrective plans to committed diagnoses, preventing drift into speculative restructuring.
- **Runtime degeneration detection.** In `src/agents/worker/ipc-bridge.ts`: harness-level accumulator on `assistant_turn` content fields; trigger on ≥3 verbatim repetitions of any 10-token span in the last 200 tokens. On trigger: terminate worker early, route to replan. Simpler than FFT; catches the production failure mode. Defer until a real degeneration event is observed.

#### Risks and gotchas

- Anti-padding instructions can cause under-specification. Pair with positive signal: "the most valuable sentence names a specific file path, function name, or test command."
- Additional JSON schema constraints beyond TypeBox schemas reduce reasoning quality (arXiv:2408.02442). Field reordering and density instructions work at the prompt level without adding constraints.

---

### Composed Q1 prompt blueprint for gvc0's planner

Three-turn structure within one `plan` agent session, composing SoT + CoD + degeneration mitigations.

**Turn 1 — Skeleton commitment (SoT phase 1)**

```
Before calling any proposal tool, write a fenced outline:

```outline
1. <task name (3–5 words)> — <one sentence: what unique capability this task proves>
   dep: [task names this depends on, or none]
   type: sequential | parallel
...
```

Constraints: commit to this task list. Do not add tasks during expansion.
Do not call addTask until the outline block is complete and counts are final.
```

**Turn 2 — Expansion with density check (SoT phase 2 + CoD)**

```
For each task in the outline, call addTask(...):
- description: 2–3 sentences max. Each sentence must name a specific file,
  function, interface, or test command. If you cannot fill 2 sentences
  with specific content, raise the under-specification as a risk note.
- objective: one sentence. Start with a verb. Name the capability that
  exists after this task and did not exist before.
- outcomeVerification: one sentence. Name the command or artifact that
  proves completion. No hedging language.
- expectedFiles: write-or-structurally-modified files only.

Density check before each addTask call: what is the one implementation
detail or dep rationale a worker would need to discover by reading code
if it were missing here? Compress it into an existing sentence.
Ground every added detail in a file or pattern named in the Research Summary.
```

**Turn 3 — Submit (commitment closure)**

```
Call submit(...) with fields in this order:
1. chosenApproach — why this approach over alternatives (not what tasks do)
2. keyConstraints — one sentence each
3. decompositionRationale — one item per seam in the task DAG
4. orderingRationale — one item per non-obvious dependency
5. verificationExpectations — one item per observable test target
6. risksTradeoffs — one item per assumption that, if wrong, changes the plan
7. assumptions — explicit; the verify phase will check these
8. summary — compress the above into 2–3 sentences; write this last
```

**Anti-degeneration footer (recency-position anchor):**

```
Reminder: each task must do work the others cannot. Every sentence must
contain a specific name. Padding tasks and vague objectives both reduce
plan value. Summary is written last, not first.
```

*Target files:* `src/agents/prompts/plan.ts` (skeleton + density + anti-padding), `src/agents/tools/schemas.ts` (reorder `proposalSubmitSchema`), `src/agents/worker/ipc-bridge.ts` (optional runtime degeneration detection).

---

## Cluster D — RAG vs long-context, batch + semantic caching

### D1. RAG vs. long-context for gvc0 (Q2)

#### Findings

**The quality gap is real and quantified.** Gemini 2.5 Pro reaches 99.7% single-fact retrieval but **falls to ~60% on realistic multi-fact tasks**. Databricks benchmarks: most models *peak* at 16k–64k tokens then degrade. GPT-4 Turbo peaks at 0.641 score at 16k, drops to 0.560 at 125k; Claude 3.x-Sonnet peaks at 0.668 at 16k, falls to 0.485 at 125k — a 27% decline. A 300-token focused prompt on LongMemEval dramatically outperformed a 113k-token full-context prompt across all 18 models tested (Chroma context-rot research, 2025).

**"Lost in the Middle" is not resolved.** The original Liu et al. U-shape (positions 5–15 of a 20-item list degrade 30%+ vs. primacy/recency) was confirmed by MIT architecture-level analysis in 2025: position bias arises from attention masking and positional encoding choices baked into training. **No frontier model fully escapes it; Claude models decay slowest.** For multi-fact queries: each individual fact may be findable in isolation, but tasks requiring synthesis require all facts attended simultaneously, compounding the degradation.

**The cost gap is 1,250x, not a rounding error.** A 100k-token long-context request at GPT-4.1 rates ($2.00/MTok) costs ~$0.20 input. Equivalent RAG ~$0.00008. Latency: 160k tokens ≈20s; 890k tokens ≈60+s; production average 45s. RAG ≈1s end-to-end. For latency-sensitive roles like the replanner, this disqualifies pure long-context.

**Emerging consensus is hybrid self-routing.** For queries where <20% of the corpus is relevant (common in focused coding tasks), RAG significantly outperforms context stuffing at 1/1250th the cost. Long-context wins for global understanding tasks where the relevant fraction is unknown and the corpus fits reliably (~32k–64k practical limit).

**Claude Code abandoned vector RAG** (per Boris Cherny): staleness, reliability (code needs exact symbol references not semantic similarity), complexity, security. Argument applies most strongly to *pre-indexed* static vector stores. **Tool-mediated on-demand retrieval avoids staleness but burns tokens through exploratory spirals on large codebases.** Skeleton index mitigates by giving a hypothesis-forming starting point.

**Structural coherence in the haystack paradoxically hurts.** Chroma research found logically structured haystacks hurt model performance more than shuffled — models follow the logical structure even when the target violates it. **Implication for gvc0:** dumping a well-organized set of related files may be *more* distracting than fewer carefully chosen ones.

#### gvc0 application

- **Tiered context assembly for the research agent.** In `src/agents/prompts/research.ts`, replace free-form `codebaseMap` injection with a two-tier structure: (a) skeleton — tree-sitter-extracted TypeScript exports for modules most likely relevant, in-degree centrality over the import graph (~1500 tokens) at primacy position; (b) tool-call layer — research agent uses `read_file` for full bodies on demand. Expected: 60–70% input token reduction for research phase. Prompt: "Consult the Codebase Index first. Identify which 2–3 modules are most likely relevant. State your hypothesis. Then read only those."
- **Ordering disciplines for injected context.** Place highest-signal items at primacy and recency positions, never mid-block. `featureObjective` and `outcomeVerification` near the top of the worker system prompt (currently `outcomeVerification` is at array position 5 of 10). For research phase, `researchOutput` should appear before `discussOutput` (research is higher signal); flip in `renderPlanningPrompt`.
- **Cross-task knowledge via structured references, not ambient injection.** The current `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md` architecture is correct. Risk: the planner currently has no mechanism to query accumulated knowledge except by reading full files. As they grow, RAG-style excerpt — planner reads via tool and searches for relevant entries before citing — scales better. Add: "Before citing references, use `read_file` to inspect those files. Include only directly relevant entries in `references`."
- **Do not add a static vector store.** Staleness and reliability arguments apply directly; gvc0 is a DAG orchestrator constantly writing across parallel branches. A vector index would go stale within a feature cycle.

#### Risks and gotchas

- JIT retrieval burns tokens through exploratory spirals when the agent has insufficient orientation. Skeleton index mitigates; without it, JIT degrades to grep-and-pray.
- Structured haystacks can be more distracting than unstructured. When assembling `dependencyOutputs` or multi-task context, prefer brevity — 3 focused dependency summaries with named files beats 10 verbose ones.
- Multi-fact queries requiring synthesis across files are the hard case neither pure RAG nor pure long-context handles well. For gvc0's planner: "what is the combined state of feature X across its in-progress tasks?" — answer distributed across task result summaries. Current `dependencyOutputs` shape is correct but needs tight per-entry token budget (~100 tokens each) to avoid attention dilution.
- Gemini 2.5 / GPT-4.1 are improving on multi-fact retrieval. Benchmark gvc0's actual planner accuracy at 16k vs. 64k vs. 128k context as the integration test harness evolves.

---

### D2. Batch inference + semantic caching (Q2)

#### Findings

**Anthropic Batch API.** Up to 100,000 requests or 256 MB per batch (whichever first). Cost: exactly **50% of standard rates** on all active models. Typical completion: under 1 hour; maximum: 24 hours, after which requests expire. Critical: results available only when *all* requests complete or 24-hour wall clock expires — no streaming partial-result access for a single submission. Rate limits apply to both HTTP requests and in-queue counts; under high demand, requests can expire unprocessed.

**Production failure mode (documented by @AdithyaGiridharan, March 2026):** HTTP 200 responses returned on submission regardless of whether requests actually process. Charges can accumulate on failed batches without alerting. No guaranteed SLA beyond 24-hour expiry.

**Prompt caching stacks with batch: 95% total cost reduction.** Cache read tokens priced at 0.1x base input rate independent of batch discount. Multipliers stack: batch (0.5x) × cache hit (0.1x) = **0.05x base price (95% off)** on the cached prefix. For Claude Sonnet 4.6: standard $3.00/MTok input → cache-hit batch rate $0.15/MTok. Anthropic docs explicitly recommend the **1-hour cache TTL** (vs. 5-min default) for batch with shared context.

**Semantic caching hit rates and false positive risk.** Production hit rates: Redis LangCache up to 70% (Mangoes.ai); GPTCache 40–73%; SWE-Bench code generation ~45%. **False positive problem is severe before tuning:** InfoQ banking case study measured 19.3%–99% FP rates across seven embedding models at default thresholds; even after threshold tuning alone, 13.4%–27.2%. Multi-layer approach (cache architecture + threshold tuning + distractor pre-population) reduced best model to 3.8% FP at production. Fundamental issue: cosine similarity does not reliably distinguish "check email" from "send email" (similarity 0.91) or "summarize file X" from "summarize file Y" in code contexts.

**The W5H2 structured intent paper is the most actionable.** GPTCache achieves only 37.9% accuracy on MASSIVE benchmarks because embedding similarity conflates semantically-close-but-action-different queries. W5H2 reframing: separate *consistency* (same key for same intent) from *accuracy* (correct answer). Solution: decompose cache keys into (What, Where) structured fields — for code-context: What = operation type (read_file, summarize, search), Where = file path or scope.

**vCache (arXiv:2502.03771):** verified semantic caching with **12.5x higher hit rates and 26x lower error rates** vs. static-threshold baselines, via per-prompt adaptive thresholds learned online. Each cached prompt learns its own reliability threshold.

#### gvc0 application

**Batch-eligibility audit:**

| Call type | Latency sensitivity | Batch eligible? |
|---|---|---|
| Planner `discuss` | Low (feature start) | Yes |
| Planner `research` | Low (sequential pre-planning) | Yes |
| Planner `plan` | Low | Yes |
| Planner `verify` | Medium (gate for merge) | Borderline — merge-train delay acceptable |
| Planner `summarize` | Low | Yes |
| Replanner | High (incident response) | **No** |
| Worker tool-call inner loops | Very high | No |
| Worker initial system-prompt call | Medium | No — blocks task start |

- **Enable Batch API for planner feature-phase calls** (discuss/research/plan/verify/summarize). Add a `batchId` column to relevant persistence tables; poll for completion as part of the feature-phase orchestrator state machine; handle 24-hour expiry as retriable. Critical: do not use batch for replan calls.
- **Combine batch with prompt caching for the planner system prompt prefix.** `PLANNING_DOCTRINE` is identical across all planning calls. Configure `cache_control` with **1-hour TTL** in pi-sdk agent config. Combined: effective input rate drops from $3.00/MTok to $0.15/MTok (95% reduction).
- **File-summary semantic cache via SHA-keyed exact match in SQLite.** New table `file_summary_cache(file_path, git_sha, summary, ...)`. Multiple features touching overlapping codebase sections summarize the same files — common for `@core/types`, `@persistence/schema`, etc. Safe from false positives because key includes exact git SHA. Inject summaries when research agent calls `read_file` on a file that already has a summary for the current SHA. Cache invalidation is trivially correct.
- **Do not implement an embedding-based semantic cache for code prompts without structured-key discipline.** False positive risk in code context is material. If you do add semantic caching for task-level operations, key on (operation type, entity) pair as structured fields — not raw embedding.
- **Replanner: not batch-eligible, but cacheable.** Apply prompt caching with 5-minute TTL to the `PLANNING_DOCTRINE` prefix in the replan template. Break-even at 1.25 cache-writes vs. 10x savings; guaranteed for any feature triggering a replan within a session.

#### Risks and gotchas

- Batch API expiry is real and undocumented as a hard guarantee. Treat as retriable error, not fatal. Implement exponential backoff with re-submission.
- Silent HTTP 200 failures: submission endpoint returns 200 even on failure. Verify actual result counts via `GET /v1/message_batches/{id}` before marking complete.
- 24-hour ceiling is a planning constraint. A massive-parallelism scenario could submit dozens of batch jobs simultaneously; results may not all return within 1-hour window. Design orchestrator for hours-scale latency.
- File-summary SHA cache requires invalidation on branch merges. If keyed on `{filePath}:{feature-branch-HEAD-sha}`, invalidation is free since HEAD changes on every squash-merge. If keyed on blob sha, more granular but requires git cat-file lookup per entry.

---

## Cross-cluster interactions

**Caching vs. compression directionality.** Caching demands prefix stability (exact byte match). Compression in the system prompt produces variable content that busts the cache. Resolution: **never compress content above the last cache breakpoint.** Compress only the dynamic tail and conversation history. Anthropic's prompt caching never applies to user/assistant/tool_result messages anyway, so compressing conversation history reduces total tokens re-sent without touching cache stability.

**Reasoning budgets vs. context engineering.** Extended thinking produces output-side reasoning tokens not re-sent on subsequent turns — enabling extended thinking for plan does not contribute to context accumulation. What does accumulate is tool call history. The 70% compaction trigger is complementary: thinking handles per-turn reasoning quality; compaction handles accumulated noise.

**TALE/BudgetThinker insight applies to compaction itself.** Compaction is not free — it requires an LLM call. Whether and how aggressively to compact is structurally a reasoning budget decision: spend tokens now (compaction) to save tokens later (reduced context). The 70% trigger is the right boundary. Refinement: sessions with mostly tool-result content (worker debugging) benefit more from compaction than sessions with mostly reasoning text (planner discussions), because tool results compress 10:1 to 20:1 vs. 3:1 to 5:1 for conversation history.

**Routing vs. compression composition.** Smaller models need more context to stay above their capability floor. **Do not compress input to light-tier workers.** Route first, compress second. Compression and downtiering applied jointly can cross the floor that either change alone would not.

**TOON/TSV vs. LLMLingua targeting.** Tabular tool results (the B1 savings target) are *also* high-density structured data that LLMLingua should not touch. Correct architecture: TSV/pipe-delimited for tool result payloads (B1); LLMLingua only on narrative fields like free-text summaries and research prose (B2). Different content types; do not overlap.

**RAG savings create batch headroom.** D1's tiered context (research dropping from 30k to 10k input tokens) compounds with batch (0.5x) and cache (0.1x for prefix): 0.33x × 0.5x × 0.5x ≈ 0.08x — multiplicative, not additive.

**LLM-AT Judge applies to gvc0's verify phase.** Verify currently runs heavy. Judge achieves 0.876 F1 on binary assessment using same-tier model. Combined with B1 (compact pipe-delimited `criteriaEvidence`) and B2 (compressed dependency context in verify input): lighter verify model + compact output + structured evidence = significant verify cost drop. Composite B1 + B2 + B3 optimization.

**Batch and routing interact at the replanner boundary.** Operational rule: everything routed to replanner is latency-sensitive (real-time). Everything routed to planner feature-phase pipeline is latency-tolerant (batch). Replanner/planner split in `src/agents/replanner.ts` vs. `src/agents/planner.ts` is the right seam.

---

## Tensions and open debates

- **CoT overhead vs. benefit.** Wharton's lab found no statistically significant CoT gain for one-third of model-task combinations, yet CoT is reflexively recommended. The regime boundary is genuinely unsettled, especially for "already-reasoning" frontier models where layering explicit CoT may be redundant.
- **TOON format vs. JSON.** TOON claims 30–60% reduction but underperforms established formats in comprehension tasks in some benchmarks. Not enough independent replication to trust the savings claim without caveats.
- **Long-context accuracy.** Gemini 2.5 Pro's near-100% needle-in-haystack vs. ~60% multi-fact recall. Providers report needle benchmarks (easy); realistic multi-fact remains unflattering.
- **Semantic caching correctness.** Active debate (vCache, arXiv:2502.03771) about whether semantic similarity is a reliable proxy for response reusability. A 90%-similar query can require a different answer.
- **Prompt compression accuracy cliffs.** LLMLingua benchmarks are mostly on GSM8K (math). Performance on open-ended generation, summarization, long-form writing at high ratios is much less studied.
- **Drift vs. exhaustion.** Practitioner consensus shifting toward "drift kills agents before limits do," but the 65% figure is from a single vendor report; not independently replicated.

---

## Skipped — what NOT to deep-dive

- **Speculative decoding.** Inference-server optimization (2–3x throughput on self-hosted infra). Not actionable when using cloud APIs.
- **Raw few-shot vs. zero-shot comparisons.** Well-saturated with conflicting, task-dependent results. Low signal-to-noise.
- **Model quantization and distillation** (INT4, GPTQ). Infrastructure/training concerns, not prompt-level techniques.
- **LangChain/framework-specific patterns.** Most 2025 framework "prompt engineering guides" are restatements without new empirical grounding.

---

## Follow-up recommendations

1. **Verify three pi-sdk capability assumptions before implementation.** Top recommendations depend on: (a) `Agent.systemPrompt` accepting `ContentBlock[]` with `cache_control` markers (or a documented bridge); (b) pi-sdk supporting Anthropic Batch API submissions; (c) pi-sdk exposing extended-thinking `budget_tokens`. If any are missing, that becomes an upstream pi-sdk task. A read of `@mariozechner/pi-agent-core` resolves all three.

2. **Add benchmarking and a token-cost dashboard before applying compression and routing.** LLMLingua-2 needs a sidecar — not free in operational complexity. The 40–50% routing savings claim depends on plan composition (what fraction of tasks are weight ≤ 4). Recommend item #10 from the priority list (TUI metrics) first; run for one week; then make targeted changes ranked by where the actual money is going. Observability is the missing prerequisite the research is unanimous about.

3. **Open empirical questions worth running internally.** (a) Composition of SoT + extended thinking is unstudied. (b) CoD has not been validated on plan generation — only summarization variants. (c) gvc0's actual cache hit rate on the planner prompt across many features is unknown. All three are answerable with telemetry once item #10 is in place.

4. **Consider stretching the test harness to exercise routing.** `fauxModel` is deterministic and prompt-stable, which is a feature for testing; but it doesn't currently exercise tier selection or escalation. Adding routing assertions (trivial-weight tasks dispatch to light tier; escalation fires on retry) closes a gap before #4 ships.

5. **One thing worth NOT doing.** Skip semantic embedding caches for full prompts (LangCache/GPTCache style). False-positive rates in code contexts (19–99% pre-tuning, 13–27% post-tuning) plus the cosine-similarity-conflates-actions failure mode (W5H2) make these higher risk than reward. The SHA-keyed exact-match file-summary cache (#8) captures the same opportunity at zero false-positive risk.

---

## Sources

### Cluster A — caching, reasoning budgets, context engineering

- [Don't Break the Cache (arXiv:2601.06007)](https://arxiv.org/abs/2601.06007)
- [PromptHub: Caching across OpenAI, Anthropic, Google](https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models)
- [Introl: Prompt Caching Infrastructure 2025](https://introl.com/blog/prompt-caching-infrastructure-llm-cost-latency-reduction-guide-2025)
- [Prompt Caching: 90% Cost Cut](https://tianpan.co/blog/2025-10-13-prompt-caching-cut-llm-costs)
- [Token-Budget-Aware LLM Reasoning / TALE (arXiv:2412.18547)](https://arxiv.org/abs/2412.18547)
- [BudgetThinker (arXiv:2508.17196)](https://arxiv.org/abs/2508.17196)
- [Token Economics of CoT 2026](https://tianpan.co/blog/2026-04-10-token-economics-chain-of-thought-when-thinking-costs-more)
- [Anthropic: Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic Cookbook: Tool-Use Context Engineering](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- [Structured Distillation 11x (arXiv:2603.13017)](https://arxiv.org/html/2603.13017)
- [Zylos AI Agent Context Compression (Feb 2026)](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies)
- [Augment Code: AI Agent Loop Token Cost](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints)

### Cluster B — output format, compression, routing

- [arXiv:2603.03306 — TOON vs JSON constrained decoding](https://arxiv.org/html/2603.03306v1)
- [toonformat.dev benchmarks](https://toonformat.dev/guide/benchmarks)
- [David Gilbertson — JSON costs more than TSV](https://david-gilbertson.medium.com/llm-output-formats-why-json-costs-more-than-tsv-ebaf590bd541)
- [Michael Hannecke — Beyond JSON for LLM pipelines](https://medium.com/@michael.hannecke/beyond-json-picking-the-right-format-for-llm-pipelines-b65f15f77f7d)
- [TOON: Stop Wasting Money on JSON](https://medium.com/@mianusman2209/stop-wasting-money-on-json-how-to-reduce-llm-token-usage-by-60-with-toon-9399ef735012)
- [LLM Structured Output in 2026](https://dev.to/pockit_tools/llm-structured-output-in-2026-stop-parsing-json-with-regex-and-do-it-right-34pk)
- [Microsoft Research — LLMLingua](https://www.microsoft.com/en-us/research/blog/llmlingua-innovating-llm-efficiency-with-prompt-compression/)
- [LLMLingua GitHub](https://github.com/microsoft/LLMLingua)
- [LLMLingua-2 project page](https://llmlingua.com/llmlingua2.html)
- [Evaluator Heads NeurIPS 2025 (arXiv:2501.12959)](https://arxiv.org/html/2501.12959v1)
- [LLM Routing Strategies survey (arXiv:2502.00409)](https://arxiv.org/html/2502.00409v3)
- [ACL 2025 LLM-AT — Automatic Transmission for LLM Tiers](https://aclanthology.org/2025.findings-acl.873.pdf)
- [Portkey: Task-Based LLM Routing](https://portkey.ai/blog/task-based-llm-routing/)
- [Right-Sizing LLM Consumption 2025](https://logiciel.io/blog/right-size-llm-consumption-without-slowing-teams)
- [arXiv:2408.02442 — Format restrictions reduce reasoning quality](https://arxiv.org/html/2408.02442v1)

### Cluster C — Q1 dense output

- [Skeleton-of-Thought (arXiv:2307.15337, ICLR 2024)](https://arxiv.org/abs/2307.15337)
- [SoT v3 full text](https://arxiv.org/html/2307.15337v3)
- [Microsoft Research — SoT blog](https://www.microsoft.com/en-us/research/blog/skeleton-of-thought-parallel-decoding-speeds-up-and-improves-llm-output/)
- [LearnPrompting — SoT technique](https://learnprompting.org/docs/advanced/decomposition/skeleton_of_thoughts)
- [Chain of Density (arXiv:2309.04269)](https://arxiv.org/abs/2309.04269)
- [PromptHub — CoD explainer](https://www.prompthub.us/blog/better-summarization-with-chain-of-density-prompting)
- [Mobile App Review CoD (arXiv:2506.14192)](https://arxiv.org/abs/2506.14192)
- [Code Copycat Conundrum (arXiv:2504.12608)](https://arxiv.org/html/2504.12608v1)
- [SpecRA — Degenerative repetition detection via FFT](https://openreview.net/forum?id=xVO4BqmzVD)
- [Tony Seah — 0% repetition from 15% via prompt fix](https://tonyseah.medium.com/we-reduced-llm-repetition-from-15-to-0-and-parameter-tuning-wasn-t-the-answer-e1a1cd811c3c)
- [Lilian Weng — Hallucination in LLMs (2024)](https://lilianweng.github.io/posts/2024-07-07-hallucination/)

### Cluster D — long-context vs RAG, batch + semantic caching

- [Long-Context vs. RAG Decision Framework (April 2026)](https://tianpan.co/blog/2026-04-09-long-context-vs-rag-production-decision-framework)
- [Beyond RAG vs. Long-Context: Distraction-Aware Retrieval (arXiv:2509.21865)](https://arxiv.org/abs/2509.21865)
- [Chroma — Context Rot Research](https://research.trychroma.com/context-rot)
- [Databricks — Long-Context RAG Performance](https://www.databricks.com/blog/long-context-rag-performance-llms)
- [Anthropic Batch Processing Docs](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- [Anthropic API Pricing 2026 — Finout](https://www.finout.io/blog/anthropic-api-pricing)
- [Redis LangCache](https://redis.io/langcache/)
- [Redis: LLM Token Optimization 2026](https://redis.io/blog/llm-token-optimization-speed-up-apps/)
- [GPTCache GitHub](https://github.com/zilliztech/GPTCache)
- [vCache: Verified Semantic Caching (arXiv:2502.03771)](https://arxiv.org/abs/2502.03771)
- [Why Agent Caching Fails — W5H2 (arXiv:2602.18922)](https://arxiv.org/html/2602.18922v1)
- [Reducing False Positives in RAG Semantic Caching — InfoQ](https://www.infoq.com/articles/reducing-false-positives-retrieval-augmented-generation/)
- [Claude Code RAG vs. Agentic Search — SmartScope](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)
- [Anthropic Batch API Production Experience — Medium](https://medium.com/@AdithyaGiridharan/not-so-good-experience-with-anthropics-batch-api-b9616cac861c)
- [Prompt Caching Guide 2026 — TokenMix](https://tokenmix.ai/blog/prompt-caching-guide)

---

## Adoption status

Tracks which recommendations from this synthesis have landed in gvc0. Update when status changes; reference the commit so reviewers can audit scope.

Statuses: `done` (fully applied) · `partial` (subset applied; note scope) · `open` (not yet started) · `deferred` (intentionally postponed) · `rejected` (decided against; note reason).

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| R1 — Cache-partition the worker system prompt | open | — | `buildSystemPrompt` still returns `string`; requires verifying pi-sdk `Agent.systemPrompt` accepts `ContentBlock[]` before restructuring. |
| R2 — Route planner feature-phase calls through Anthropic Batch API | open | — | No `batchId` column or polling logic exists yet; largest implementation surface in the list. |
| R3 — Cap tool result tokens at 2,000 per result | open | — | No harness-level truncation filter exists; pure harness change, no prompt changes needed. |
| R4 — Wire `task.weight` to `taskRoutingTier()` | open | — | `taskRoutingTier()` in `src/orchestrator/scheduler/dispatch.ts` still hardcoded to `'standard'`. |
| R5 — Schema reorder (`summary` last) + skeleton-commitment + density-check + anti-padding instructions | open | — | `proposalSubmitSchema` still has `summary` first; PLANNING_DOCTRINE lacks skeleton/density/anti-padding additions. |
| R6 — Enable extended thinking for plan/replan only | open | — | `budgetPressure` field exists in `ModelRoutingConfig` but per-phase thinking enable/disable not wired. |
| R7 — Tiered context for research phase + U-curve ordering | open | — | No tree-sitter skeleton index; `outcomeVerification` not yet at primacy; `discussOutput`/`researchOutput` flip not applied. |
| R8 — SHA-keyed file-summary cache in SQLite | open | — | No `file_summary_cache` migration exists. |
| R9 — Anchored iterative compaction at 70% context utilization | open | — | No `src/runtime/context/compaction.ts`; no 70%-utilization trigger. |
| R10 — Surface cache hit rate + reasoning token ratio in TUI | open | — | `cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` tracked in `TokenUsageAggregate` and persisted, but not surfaced in TUI view models. Prerequisite for R1, R2, R6. |
