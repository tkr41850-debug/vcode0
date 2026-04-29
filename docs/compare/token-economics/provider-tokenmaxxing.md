# Provider-Tokenmaxxing

Two-axis research on **provider-level prompt and cache techniques** for token efficiency. Companion to [tokenmaxxing.md](./tokenmaxxing.md), which covered the broader landscape (model routing, output-format compression, Skeleton-of-Thought, RAG, etc.). This page is narrower: only what the LLM provider's API surface lets you do with prompt structure and caching.

> **Revised after critical review (April 2026).** Four opus reviewers stress-tested the original draft and this version applies their corrections (token-minimum table, worked-example arithmetic, removal of an invented `x-session-affinity` header, paper-quoting accuracy on Lumer et al., qualified folklore, fixed pi-sdk `streamFn` claim, etc.). A second pass corrected the Cluster D framing — the original "literal per-request flat-fee billing is functionally extinct" claim was wrong; **Gemma 4 on the Gemini API has no per-token tier at all** (free with rate limits and free context caching), and every major provider runs a parallel non-per-token surface. Treat the document as carefully cross-checked but still snapshot-in-time — provider pricing and beta-flag eligibility move quickly.

## Two axes

- **Per-request billing model**: caller pays a flat amount per request, cannot choose model. Goal: pack maximum useful output into one inference call. Examples in 2026: Claude Code Pro/Max rolling-window quotas, legacy Cursor request tiers.
- **Per-token billing model**: usual provider pricing (input + output tokens with cache discounts). Goal: minimize total tokens billed for the same useful work.

In practice, "per-request" billing in 2026 is mostly rolling-window rate limits (RPM + 5-hour TPM ceilings), not true flat-fee request counting. Cursor moved to a credit pool in June 2025; GitHub Copilot moves to usage-based credits June 1, 2026. The closest live constraint is Claude Code Max's RPM / 5-hour TPM windows — every wasted call (parse retry, unnecessary compaction round-trip) burns quota.

## Method

1. **Round 1 (1 sonnet agent, websearch)**: discovery map of provider-level prompt+cache techniques across both axes.
2. **Round 2 (4 parallel sonnet agents, websearch)**: deep dives on Anthropic cache mechanics (A), agent-loop stability patterns (B), cross-provider portability (C), per-request optimization (D). Each agent received gvc0 architectural context and produced concrete recommendations.

Findings consolidated below.

---

## Cross-cluster findings (the things that surprised us)

### 1. The default cache TTL on Claude Code silently changed from 1h to 5m on March 6, 2026

Confirmed by log analysis across 119,866 API calls. No changelog entry. `ephemeral_1h_input_tokens` went from dominant to near-zero overnight. Any code path that depended on the implicit default — including agentic loops that compute "should this be cached?" without setting an explicit TTL — quietly degraded. **Always pass `ttl: "1h"` explicitly in `cache_control` when you want hour-scale caching.**

Source: [Claude Code issue #46829](https://github.com/anthropics/claude-code/issues/46829), [The Register](https://www.theregister.com/2026/04/13/claude_code_cache_confusion/).

### 2. Anthropic cache became workspace-scoped on February 5, 2026

Previously caches were shared at the organization level. Now each workspace has its own cache backing store. Multi-environment deployments (dev/staging/prod under one org) lost cross-workspace cache reuse. Bedrock and Vertex AI retained organization-level isolation.

### 3. The token minimum on Claude 4.x flagship models is up to 4096, not 1024

| Model | Minimum cacheable tokens |
|---|---|
| Mythos Preview, Opus 4.7 / 4.6 / 4.5, Haiku 4.5 | 4096 |
| Sonnet 4.6, Haiku 3.5 | 2048 |
| Sonnet 4.5, Opus 4 / 4.1, Sonnet 4, Sonnet 3.7 | 1024 |

Below the minimum the API silently returns `cache_creation_input_tokens: 0` and `cache_read_input_tokens: 0` — no error, no warning. A worker harness with a 1500-token system prompt on Opus 4.6 pays full price every turn and never caches. Detect with usage-field instrumentation; never assume `cache_control` activates caching.

### 4. The 20-block lookback ceiling is a hidden failure mode in long agent loops

Anthropic's prefix lookup walks backward at most 20 content blocks from each `cache_control` marker. Past 20, it gives up and pays write cost again — even if the entry is still within TTL. A replanner accumulating tool results past 20 blocks loses the cache silently. Mitigation: rolling breakpoints (anchor at system + trailing at conversation tail; add a third mid-conversation when growth exceeds the window).

### 5. System-prompt-only caching wins for parallel ephemeral fleets

The "Don't Break the Cache" paper (Lumer et al., arXiv:2601.06007, January 2026) measured **41–80% cost savings** across configurations on Anthropic when caching *only* the system prompt for agents with session-specific tool results. The headline 78–81% figure applies to a specific high-overlap subset; the broader range is what most workloads see. Caching full conversation history can show **increased latency and reduced savings** when prefixes don't repeat across instances (the paper does not claim "negative ROI" outright, but the savings collapse compared to system-only). The intuition flips: full-history caching wins for one long session, system-only wins for many short ones. gvc0's worker fleet (process-per-task, isolated worktrees, different problems) is firmly in the system-only regime.

### 6. Cache reads on Claude 4.x are excluded from ITPM

`cache_read_input_tokens` does NOT count against input-tokens-per-minute limits on Claude 4.x and Sonnet 3.7. With 80% cache hit rate on a 50k-token context at Tier 4 ITPM (2M tokens/min), effective throughput rises to ~10M tokens/min — a 5x multiplier. **For a parallel-worker fleet this is the largest architectural lever available.** Other providers do not document a comparable carve-out; OpenAI's docs are ambiguous on whether cached tokens count toward TPM (treat as "they likely do" until proven otherwise).

### 7. Concurrent fan-out before warmup pays the write cost N times

There's no cache-fill coalescing. If worker 1..N fire simultaneously with the same prefix and no warm entry, all N pay 1.25× or 2× write. Subsequent waves get reads. **Always send one sentinel call to warm the cache before fanning out the worker pool**, then keepalive at a comfortable margin under the TTL (the 50-min keepalive figure for 1h TTL is community folklore, not Anthropic-published guidance — adjust by measurement).

### 8. Batch API + 1h cache + warmup is the cheapest input regime available

Pricing stacks multiplicatively: Batch (50%) × cache read (0.1×) = **0.05× base** (95% off). Caveat: Batch processing can take up to 24 hours, so 5m TTL is useless inside a batch. Pattern: pre-warm with a non-batch call using `ttl: "1h"`, submit the batch within 55 minutes, segment if needed. For shared-context evaluation runs (a fleet of tasks against the same feature), this is the dominant cost lever.

### 9. Tool array mutation invalidates everything downstream — including JSON key order

Cache prefix is byte-exact. Adding, removing, reordering, or modifying any field of any tool definition busts the entire `tools → system → messages` chain. JSON serialization in Go and Swift randomizes map iteration order, so identical tool definitions produce different bytes per request and 0% hit rate. TypeScript's `JSON.stringify` is stable by insertion order — safe if objects are constructed deterministically. Build a tools-fingerprint at worker init and assert identity each turn.

### 10. Anthropic-style explicit `cache_control` is the right canonical abstraction

Across providers, caching activates differently: Anthropic (explicit block markers), OpenAI (automatic prefix, no opt-in), Gemini (dual: explicit `cachedContents` API or implicit auto), Bedrock (explicit `cachePoint` markers). The explicit Anthropic model is **strictly more expressive** — you can ignore markers on providers that don't need them, but you cannot manufacture explicit placement on a provider that only supports implicit. An SDK abstraction that surfaces `CacheHint` annotations and translates per-provider (no-op on OpenAI/Gemini-implicit, `cache_control` injection on Anthropic/Bedrock, pre-flight create on Gemini-explicit) is the right shape.

### 11. LiteLLM has confirmed bugs stripping `cache_control`

Multiple providers extending `OpenAIGPTConfig` call `remove_cache_control_flag_from_messages_and_tools()` in the request transform path, deleting cache annotations before forwarding. For cache-critical paths, **prefer direct provider clients over LiteLLM**. OpenRouter's sticky routing helps OpenAI/Gemini implicit caching but does not inject `cache_control` for Anthropic — pass it through yourself.

### 12. Server-side compaction preserves the system anchor

Anthropic's `compact-2026-01-12` beta (Sonnet 4.6, Opus 4.6/4.7, Mythos Preview) generates a `compaction` block inline within an existing response. Subsequent requests drop blocks prior to the compaction marker. The system-level cache anchor survives unchanged — only the messages-level cache is reset. **No extra request is consumed.** Critical advantage over client-side compaction (which is a separate inference call) for per-request billing.

### 13. Per-request optimization cares about TTFT, not token count

Under a rolling RPM/TPM window, request slot consumption is what matters. Caching's primary benefit shifts from cost reduction (irrelevant under flat fees) to **latency reduction** — 80% TTFT improvement on cache hits means more requests fit per minute before the rate limit binds. Same physical mechanism, different optimization gradient.

### 14. Structured outputs (grammar-constrained) have a separate 24h grammar cache

Anthropic compiles JSON Schema into a grammar at first use (100–300ms), cached server-side for 24 hours independent of prompt cache TTL. Schema structure changes (add/remove fields, change types) invalidate it; renaming `description` does not. The injected schema-explanation system content is part of the prompt cache prefix — switching schemas mid-session double-busts (grammar recompile + prompt cache invalidation).

### 15. `prompt_cache_key` on OpenAI throttles at ~15 RPM per key

OpenAI's `prompt_cache_key` is a routing hint, not a cache key. Beyond ~15 requests/minute with the same key+prefix, overflow lands on additional backend hosts where there's no warm entry — hit rate degrades. For a high-throughput agent fleet sharing one prefix, this is a soft ceiling: throughput keeps scaling, but cache-hit rate trends down past the threshold.

---

## Top priorities for gvc0 (ranked by ROI)

Distilled across all four clusters. Rank reflects expected savings × implementation simplicity.

### 1. Explicitly set `ttl: "1h"` on tools and system breakpoints in `@runtime/context-assembly`
Do not rely on the default. As of March 6, 2026, the default is 5m and that is wrong for any agent loop with intra-task gaps > 5 min. Two-line change with the largest blast radius.

### 2. Pre-warm the cache before worker fan-out
In `@orchestrator/scheduler`, fire one blocking sentinel call with the canonical tools+system prefix before launching a wave of workers. Schedule a keepalive at a comfortable margin under TTL (e.g. 45–55 min for 1h TTL — exact figure is folklore, measure it). Without this, every concurrent worker in the first wave pays 1.25–2× write cost.

### 3. System-prompt-only caching for the worker harness
Workers are short, parallel, and process distinct problems — system-only caching is the right regime per the arXiv paper (41–80% savings range, 78–81% in the high-overlap subset). Move all dynamic content (feature name, task ID, worktree path) **out of the system prompt** and into the first user message. Single anchor breakpoint at the end of the system prompt with `ttl: "1h"`.

### 4. Freeze the tools array per worker class with a stability hash
In `@agents/planner` and `@agents/replanner`, construct the tools array once at module init. Hash the serialized form. Assert identity on every API call and fail loudly on drift. Add a `tools-fingerprint` integration test in `test/integration/`.

### 5. Two-breakpoint pattern + server-side compaction for planner/replanner
Long-running agents need: anchor breakpoint (1h TTL) at end of system, trailing breakpoint (5m TTL) at conversation tail. Enable `compact-2026-01-12` beta on planner/replanner calls — preserves the system anchor through compaction events with no extra request.

### 6. Track all four cache usage fields per turn in `@persistence/`
Store `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`, `output_tokens` (and split `ephemeral_5m` / `ephemeral_1h` when present) in the `agent_runs` row. Cost computation based only on `input_tokens` is wrong by orders of magnitude for cache-heavy workloads.

### 7. Below-minimum guard in context assembly
Estimate prefix tokens before emitting `cache_control`. Skip the marker and log `WARN cache_below_minimum` when below threshold (4096 for Opus 4.7/4.6/4.5 / Haiku 4.5 / Mythos Preview; 2048 for Sonnet 4.6 / Haiku 3.5; 1024 for Sonnet 4.5 and earlier). Silent no-ops are an invisible cost leak.

### 8. Lock `budget_tokens` for thinking agents at session start
For planner/replanner using extended thinking, decide `budget_tokens` once at session start and freeze it. Every change busts the message-level cache. Use Sonnet 4.6 or Opus 4.5+ (not Haiku) — Haiku strips thinking blocks on each non-tool-result turn, defeating cached-thinking reads.

### 9. Tool-result clearing via `transformContext` hook
Wire a pi-sdk extension that drops tool-result bodies older than 5 turns, **only for results positioned after the system anchor breakpoint** (dropping content before the anchor would invalidate it). For file-heavy tasks this typically reduces per-turn tokens 40–70% without touching the cache.

### 10. Track `tools-fingerprint` × cache-hit-rate per worker class in TUI
Surface real-time cache hit rate per worker class. Alert when worker hit rate drops below 80% — single best canary for prefix mutation, tool-schema drift, or TTL expiry.

### 11. Structured outputs on all known-schema calls
Wrap every planner/replanner call that emits a known shape (DAG state, task plan, conflict resolution decision) with `output_config.format`. Eliminates parse-retry slots; zero-token output specification (vs. ~100 tokens of prose schema instructions); compatible with prompt cache.

### 12. Verify `disable_parallel_tool_use` is never set unless required
DAG-structured task work is naturally parallel. The default (parallel) is correct. Audit `@agents/*` for any code path that sets `disable_parallel_tool_use: true`.

### 13. Verify no auto-fallback on cancellation in worker IPC path
The double-billing pattern is a Claude Code product bug; pi-sdk's worker loop does **not** silently auto-retry as non-streaming on cancellation. Lower priority than presented, but worth a one-time audit of the IPC cancel path in `@runtime/` to confirm no future regression introduces fallback retries.

### 14. Direct provider clients for cache-critical paths
Do not route Anthropic requests through LiteLLM (confirmed bug class strips `cache_control`). OpenRouter is acceptable for OpenAI/Gemini where caching is implicit, but bypass it for Anthropic.

### 15. Use Batch API + 1h cache for shared-context evaluation runs
When `@orchestrator/` identifies tasks sharing the same tools+system prefix (e.g., evaluation across a feature), pre-warm with a non-batch call (1h TTL), then submit as a batch within 55 minutes. Effective input cost: 0.05× base — 95% off. Largest cost lever for repeated-context workloads.

### 16. Adopt a `CacheHint` annotation in pi-sdk
Provider-portable abstraction: stable section, TTL preference, breakpoint position. Translates to `cache_control` injection on Anthropic/Bedrock, no-op on OpenAI/Gemini-implicit, pre-flight `cachedContents.create()` on Gemini-explicit. Future-proofs gvc0 against provider swaps without leaking provider syntax into orchestration code.

---

## Suggested PR sequence

1. **PR-1**: Set `ttl: "1h"` explicitly + record all four cache usage fields. Smallest change, largest visibility win. Without this, no later PR is measurable.
2. **PR-2**: System-prompt-only restructure for workers — push dynamic content from system into first user message. Add tools-fingerprint hash + stability test.
3. **PR-3**: Cache pre-warmup in `@orchestrator/` before worker fan-out + sub-TTL keepalive (start at ~50 min for 1h TTL; tune by measurement).
4. **PR-4**: Below-minimum guard + structured outputs for known-schema planner/replanner calls.
5. **PR-5**: Two-breakpoint pattern + server-side compaction for planner/replanner.
6. **PR-6**: Tool-result clearing `transformContext` hook (post-anchor only).
7. **PR-7**: Cache hit rate + reasoning ratio TUI surface.
8. **PR-8**: Audit IPC cancel path for non-streaming-retry regression risk.
9. **PR-9**: Batch API path for shared-context evaluation runs (depends on PRs 1–3 being landed).
10. **PR-10**: pi-sdk `CacheHint` abstraction (upstream contribution; defers cross-provider portability work).

PRs 1–3 are independent and small; bundle if desired. PRs 4–8 each stand alone. PR-9 requires the warm-cache infrastructure from PR-3.

---

## Cluster A — Anthropic cache mechanics (concrete)

### Breakpoint placement (4 max per request)
- Hierarchy: `tools` → `system` → `messages`. Marker at `system` implicitly covers `tools`; marker at `messages` covers everything before it.
- TTL ordering: 1h breakpoints **must** appear before 5m in prompt order. Violation → HTTP 400.
- Top-level `cache_control: {type: "ephemeral"}` on the request enables automatic management; explicit per-block markers give fine-grained control. Mixing them with all 4 slots filled → 400 "no slots left for automatic caching".

### 20-block lookback window
- Counts content blocks (text entry, image, tool_use, tool_result), not message-array entries. A message with `[text, image]` is 2 blocks.
- Past 20 blocks: silent miss even if entry is within TTL.
- Rolling pattern: anchor at end of system + trailing at conversation head; add a third mid-conversation when growth exceeds 15 new blocks.

### TTL economics (Sonnet 4.6 base $3/MTok)
| TTL | Write multiplier | Read multiplier | Break-even reads |
|---|---|---|---|
| 5m | 1.25× ($3.75/MTok) | 0.1× ($0.30/MTok) | ≥2 |
| 1h | 2.0× ($6.00/MTok) | 0.1× ($0.30/MTok) | ≥3 |

Use 5m if turns happen ≤5 min apart. Use 1h for 5–60 min gaps. Don't bother caching for >60 min gaps.

### Token minimums (April 2026)
- 4096: Mythos Preview, Opus 4.7/4.6/4.5, Haiku 4.5
- 2048: Sonnet 4.6, Haiku 3.5
- 1024: Sonnet 4.5, Opus 4/4.1, Sonnet 4, Sonnet 3.7
- Below threshold: silent no-op, both cache fields return 0.

### Usage-field accounting
```json
{
  "usage": {
    "cache_creation_input_tokens": 7950,
    "cache_read_input_tokens": 44000,
    "input_tokens": 120,
    "output_tokens": 380
  },
  "cache_creation": {
    "ephemeral_5m_input_tokens": 2000,
    "ephemeral_1h_input_tokens": 5950
  }
}
```
`input_tokens` is **only post-last-breakpoint tokens**, not total input. Total = `cache_read + cache_creation + input_tokens`.

### ITPM exclusion (Claude 4.x and Sonnet 3.7)
Cache reads do NOT count against input-tokens-per-minute limits. Haiku 3.5 is marked `†` — reads still count. Architectural implication: parallel-worker fleets aggressively caching shared contexts get effectively unlimited cache-read throughput.

### Batch API + cache stacking
- Batch + 5m write: 0.625× base (37.5% off)
- Batch + 1h write: 1.0× base (no write savings)
- Batch + cache read: 0.05× base (**95% off**)
- 24h batch processing window — 5m cache useless inside batch; 1h cache requires segmenting batches to <55 min each.

### Extended thinking interaction
- Thinking blocks are NOT directly markable with `cache_control`.
- Cached as part of prior assistant turn content; show up in `cache_read_input_tokens` when read.
- Changing `budget_tokens` invalidates message-level cache. Toggling thinking enabled/disabled invalidates message-level cache.
- Opus 4.5+ and Sonnet 4.6+ preserve thinking blocks across non-tool-result user messages; Haiku and earlier strip them.

### Structured outputs / grammar cache
- `output_config.format` (post-beta API) compiles JSON Schema → grammar; 24h server-side grammar cache, separate from prompt cache.
- Schema-structure change → recompile + prompt-cache invalidation.
- Adds a system prompt explaining the format — part of the cacheable prefix.

### Foot-guns
1. Tool array mutation (any change) → full downstream cache bust.
2. `tool_choice` / `disable_parallel_tool_use` change → tools+system invalidation.
3. System message edit (even one period) → cascading bust.
4. JSON key-order non-determinism in Go/Swift SDKs → 0% hit rate.
5. March 6, 2026 silent 1h→5m default change.
6. Below-minimum silent no-op.
7. Concurrent write storm without warmup.
8. Workspace isolation since Feb 5, 2026.

---

## Cluster B — Agent-loop stability patterns

### Static-first ordering (canonical)
`tools (cache_control on last) → system (cache_control at end) → few-shot → conversation tail (cache_control trailing)`.
Zero dynamic content in the static prefix. No timestamps, no session IDs, no per-user metadata, no nonces in tool descriptions.

### Conversation continuation
- Auto-cache: top-level `cache_control` on request — breakpoint walks forward each turn.
- Two-breakpoint manual: anchor at end of system + trailing at conversation tail. Walk-back finds anchor when trailing misses, avoiding full re-encode.
- Three+ breakpoints (SOC-agent pattern): system Bp4 (1h) → previous assistant Bp3 → previous user Bp2 → current user Bp1. Lookback always finds something within 4–5 blocks.

### System-only caching strategy
- arXiv 2601.06007 (Lumer et al., Jan 2026) finding: 41–80% savings on Anthropic across configurations for parallel agents with session-specific tool results; the 78–81% headline applies to a high-overlap subset.
- Full-history caching shows **increased latency and reduced savings** when prefixes don't repeat across instances; the paper does not call this "negative ROI" outright but the ratio collapses vs. system-only.
- Win condition for system-only: parallel fleet, ephemeral sessions, distinct problems per worker.
- Win condition for full-history: single long-running session iterating the same content.

### `defer_loading` for dynamic tool sets
- All tools in the `tools` array; mark non-essential ones with `defer_loading: true`.
- Tool Search Tool (regex or semantic) discovers them when needed.
- 85% reduction in tool-definition tokens (72k → 8.7k for a 50+ tool catalog in Anthropic's testing).
- Accuracy improvement: Opus 4.5 79.5% → 88.1% on complex tool selection.
- Cost: extra round-trip per tool discovery. Worth it when only 3–5 of 50+ tools are used per task.

### Compaction strategies vs cache
| Strategy | Cache impact | Verdict |
|---|---|---|
| Sliding window (drop front turns) | Full conversation prefix invalidation | Avoid |
| Hierarchical summarization (rewrite prefix) | Full invalidation | Acceptable if compaction replay cost > replay-full-history cost |
| LLMLingua token-level pruning | Non-deterministic; breaks prefix stability | Incompatible with cache |
| Anchored compaction (informal term — system anchor + messages-only rewrite) | System anchor preserved; only messages-level invalidated | **Recommended** |
| Tool-result clearing post-anchor | No invalidation | **Lightest, recommended** |
| Anthropic server-side `compact-2026-01-12` | Anchor preserved; no extra request | **Recommended on supported models: Sonnet 4.6, Opus 4.6/4.7, Mythos Preview** |

Compaction cost model: compaction inference + 1 turn cache miss vs. cost of replaying full history. Compaction wins past ~10 remaining turns.

### Tool result handling
- Truncate at source (e.g., 4096 tokens for file reads).
- Drop bodies older than 5 turns post-anchor.
- "Lost in the middle" (Liu et al. 2023, arXiv:2307.03172): 30%+ accuracy drop when relevant content shifts to middle positions; keep important results trailing.

### Parallel-worker fleet
- Cache is per-API-key, per-workspace.
- Worker 1 turn 1 = write; workers 2..N turn 1 = read.
- Pre-warm with sentinel call. Keepalive at a comfortable margin under TTL (50-min figure for 1h is community folklore — measure and tune).
- Round-robin replica routing risk: a cached prefix may have <1/1 hit probability across backend replicas. Anthropic does not document a public session-affinity header; rely on `prompt_cache_key`-style routing hints where available and otherwise accept best-effort affinity.

### Real-world cases
- ProjectDiscovery: 7% → 84% hit rate, 59–70% cost reduction. Three-breakpoint layout (system 1h + tool defs + conversation tail 5m). "Relocation trick" — moving dynamic working memory out of system prefix into tail user message — alone went 7% → 74%.
- Claude Code 5-layer pipeline: budget reduction → snip → microcompact → context collapse → semantic auto-compact. Cheapest-first; layers 1–2 don't bust cache.
- SDK compaction at 5k threshold: 198k → 82k tokens on a 37-turn ticket task (~58.6% reduction).

---

## Cluster C — Cross-provider portability

### Comparison matrix

| Dimension | Anthropic | OpenAI | Gemini | Bedrock |
|---|---|---|---|---|
| Activation | Explicit `cache_control` blocks (or top-level auto) | Automatic prefix; optional `prompt_cache_key` routing hint | Dual: explicit `cachedContents` API + implicit auto (2.5+) | Explicit `cachePoint` markers in Converse API |
| TTL | 5m or 1h, caller-selected; 1h must precede 5m | ~5–10 min default; 24h via `prompt_cache_retention: "24h"` (mandatory on gpt-5.5+); Azure has no 24h | Explicit: configurable; Implicit: provider-managed | 5m default; 1h available only on Claude Haiku 4.5 / Sonnet 4.5 / Opus 4.5 |
| Write cost | 1.25× (5m) / 2.0× (1h) | None | Explicit: storage fee per MTok/hr (AI Studio: $1 Flash, $4.50 Pro; Vertex 2.5 Pro: $0.3125); implicit free | ~1.25× base; Nova has no surcharge |
| Read cost | 0.1× (90% off) | 0.5× current pricing on gpt-4o (50% off); 0.1× on newer (gpt-5.x) lines per current docs | Vertex 2.5+ explicit/implicit: 0.1×; AI Studio explicit: 0.25× | ~0.1× |
| Token minimum | 4096 (Mythos / Opus / Haiku 4.5); 2048 (Sonnet 4.6, Haiku 3.5); 1024 (older 4.x, Sonnet 3.7) | 1024 | Implicit: 1024 (Flash) / 2048 (Pro); Explicit: 2048+ | 1024 first checkpoint; 2048 cumulative second |
| Observability | `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m/1h_input_tokens` | `usage.prompt_tokens_details.cached_tokens` | `usageMetadata.cachedContentTokenCount` | `CacheReadInputTokens`, `CacheWriteInputTokens`, `CacheDetails.ttl` |
| Rate-limit relief | Cache reads excluded from ITPM (Claude 4.x, Sonnet 3.7) | Not documented as excluded — assume cached tokens count toward TPM | Not documented | None |
| Workspace scope | Per-workspace (Feb 5, 2026+) | Per-account | Per-project | Per-AWS-account, per-region |

xAI Grok and DeepSeek (omitted from the matrix above) both ship automatic prefix caching with provider-managed TTLs and read discounts comparable to OpenAI's; treat them as "OpenAI-shaped" for portability purposes.

### Worked example: 50k-token prompt, 10 requests (write + 9 reads)

| Provider | Total cost | vs. uncached |
|---|---|---|
| Anthropic Sonnet 4.6, 5m | $0.32 | ~78% off |
| Anthropic Sonnet 4.6, 1h | $0.44 | ~71% off |
| OpenAI gpt-4o (50% cache discount) | ~$0.69 | ~45% off |
| OpenAI gpt-5.x (90% cache discount per current docs) | ~$0.24 | ~81% off |
| Gemini 2.5 Pro implicit | $0.12 | ~81% off (best, if hit rate holds) |
| Gemini 2.5 Pro explicit (1h, AI Studio storage) | $0.34 | ~45% off (storage fee dominates) |
| Gemini 2.5 Pro explicit (1h, Vertex storage) | ~$0.20 | ~67% off |
| Bedrock Claude 3.5 Sonnet v2 | ~$0.32 | ~78% off |

Numbers are illustrative — verify against current provider pricing before using as a basis for any decision. The shape is what matters: Gemini implicit and Anthropic both reach ~78–81% off in steady state; gpt-4o's 50% cache discount is materially weaker than its newer-generation lines; Bedrock matches Anthropic percentage-wise at slightly higher absolute price.

### Per-provider foot-guns
- **Anthropic**: TTL ordering, 20-block lookback, workspace isolation, March 2026 default change, silent below-minimum, tool-array mutation cascade.
- **OpenAI**: `prompt_cache_key` ~15 RPM throttle; Azure no 24h retention; OpenAI does not document cached tokens as excluded from TPM (treat as if they count until proven otherwise).
- **Gemini**: Explicit storage fees accumulate if you forget to delete; AI Studio vs Vertex pricing differences; Cloud Storage object mutation silently invalidates cache.
- **Bedrock**: 5m TTL forces miss on most batch jobs; cross-region inference (CRIS) routes between regions and cache does not survive — under load, hit rate degrades.

### Proxy layers
- **LiteLLM**: Confirmed bug class strips `cache_control` for providers extending `OpenAIGPTConfig` (Minimax, GLM, intermittently Azure gpt-5.2). Has its own semantic-cache layer separate from provider-level KV caching.
- **OpenRouter**: Sticky routing via prefix hash — works for Anthropic if `cache_control` passes through, helps OpenAI/Gemini implicit. Manual `provider.order` overrides break sticky routing.
- **Recommendation**: bypass proxies for Anthropic cache-critical paths.

### SDK abstraction implications
1. Caller-specified `CacheHint` annotations are necessary (auto-deduction can't know stable vs. variable from content alone).
2. Anthropic's explicit model is the right canonical abstraction; per-provider transports translate it (no-op on OpenAI/Gemini-implicit; pre-flight `cachedContents.create()` on Gemini-explicit).
3. SDK invariants: stable JSON key ordering; no per-request timestamps in cached prefix; separate "stable" vs "growing" message tracking; TTL-aware invalidation logic; workspace-scoped cache state assumption.

---

## Cluster D — Non-per-token billing surfaces

**Framing correction (April 2026):** the earlier draft claimed "literal per-request flat-fee billing is functionally extinct in 2026." That overstates. Per-token *is* the default for production paid frontier traffic, and GitHub Copilot's June 1, 2026 migration to AI Credits removes one of the largest remaining request-denominated paid surfaces — but every major provider operates a parallel rate-limited free or flat-fee surface, and at least one notable model (**Gemma 4 on the Gemini API**) has **no per-token tier at all** — only a free, rate-limited surface, with context caching also free.

### The non-per-token landscape splits three ways

**1. Request-denominated** (meter is request count: RPM, RPD, monthly call quota)
- **GitHub Models marketplace** (distinct from Copilot): high-tier models 10 RPM / 50 RPD; low-tier 15 RPM / 150 RPD; 8K input / 4K output per request. Free prototyping surface; opt into per-token to scale.
- **GitHub Copilot Pro/Pro+**: still request-denominated through 2026-06-01, then migrates to AI Credits ($10 / $39 monthly).
- **OpenRouter `:free` models**: 20 RPM, 50 RPD baseline (1000 RPD if any paid credits ever purchased). Llama 3.1/3.3 plus ~30 others.
- **Cohere trial keys**: 1,000 calls/month flat + per-endpoint RPM caps. Non-commercial.

**2. Token-quota with rate limits** (meter is tokens, but the quota is flat — no per-token cost)
- **Gemini API free tier** (Gemini 2.5/3.x family): Flash-Lite ~15 RPM / 1000 RPD, Flash ~10 RPM / 250 RPD, Pro 5 RPM / 100 RPD, 250K TPM shared. Quotas were cut 50–80% on 2025-12-07. Implicit caching (~90% off) is on by default for 2.5+.
- **Gemma 4 on Gemini API** — **no paid tier exists**. Free for input, output, and context caching. Rate-limited by the same Gemini API tier system. The single cleanest counter-example to "per-token has won."
- **Mistral La Plateforme "Experiment"**: ~1B tokens/month free across open-weight + smaller commercial models.
- **Groq free tier**: 30 RPM, 6K TPM, 14.4K RPD across Llama 3.3 70B, Llama 4 Scout, DeepSeek R1 Distill, Qwen QwQ, Mistral Saba.
- **Cerebras Inference free**: 1M tokens/day, 30 RPM, 60–100K TPM, 8K ctx (some models 64K), Llama 3.3 70B / Qwen3 32B / Qwen3 235B / GPT-OSS 120B. No expiry.
- **xAI Grok free**: 10 prompts / 2 hours.
- **DeepSeek**: 5M trial tokens; no enforced per-user RPM cap in normal operation.

**3. Concurrency-gated or wall-clock-billed** (denomination axes the doc previously missed)
- **Featherless.ai**: $10 / $25 / $75 monthly tiers gated by **concurrency** (2 / unlimited / 8+ concurrent), not tokens or requests. Open models only.
- **Hugging Face Inference Endpoints**: per-hour, per-minute granularity ($0.03–$80/hr by hardware), serverless scales to zero. Time-denominated.
- **Cursor**: credit pool since June 2025 (token-priced under the hood, but the user surface is a flat monthly bucket).
- **Claude Code Pro/Max**: rolling RPM + 5-hour TPM windows. Bucket is **token-denominated**, not request-denominated — important for output-length tradeoffs.
- **Gemini Enterprise**: $30/user/month flat seat.

**4. BYOK code agents** (token-billed via provider, surface is just transport)
- Cline / Aider / Roo / Continue: provider rules apply.

### Mindset shift (which meter binds?)
| Dimension | Per-token billing | Request-denominated | Token-quota free tier | Concurrency-gated |
|---|---|---|---|---|
| Input tokens | Minimize aggressively | Less critical (request count is the meter) | Minimize against monthly token quota | Indifferent — bucket is concurrency |
| Output tokens | Minimize aggressively | Maximize usefulness — one slot regardless of length | Minimize against monthly token quota | Indifferent within session, but long outputs hold a concurrency slot longer |
| Retries | Expensive (N× tokens) | Catastrophic (N× slots — burns the daily cap) | Catastrophic (N× tokens against quota) | Holds the slot longer |
| Structured output | Helpful for parsing | Essential | Essential | Helpful |
| Parallel tool calls | Saves tokens | Saves slots — primary lever | Saves time (rate-limit headroom) | Reduces concurrency-slot duration |
| Cache hits | Save money | Save time → more slots fit before window binds | Save quota tokens | Save concurrency-slot wall-clock |
| Compaction | Avoid (extra request, extra tokens) | Enable server-side (no extra slot) | Enable server-side (no extra tokens) | Reduce wall-clock |
| Claude Code Max specifically | n/a | n/a — bucket is token-denominated | This is the live constraint for gvc0 | n/a |

### Provider-level levers (prompt + cache only)
The same levers that help per-token also help quota-bounded — the difference is what they save (cost vs. throughput headroom), not which knobs to turn.

1. **Structured outputs** (`output_config.format`): grammar-constrained generation eliminates parse retries. Zero schema-prose overhead. Free.
2. **Token-efficient tool use** (built into Claude 4+): up to 70% output token reduction on tool calls (avg 14%); lower TTFT.
3. **Parallel tool calls** (default): N independent tool calls in one assistant turn → 2 requests instead of N+1. Never set `disable_parallel_tool_use` unless data dependencies require it.
4. **Advanced tool use** (`advanced-tool-use-2025-11-20`): tool search + programmatic tool calling; 37% token reduction in Anthropic's worked example, can collapse 15+ round-trips to 2.
5. **Server-side compaction** (`compact-2026-01-12`): prevents context-overflow failures with no extra request slot consumed.
6. **Caching for TTFT**: under rolling-window quotas, faster requests = more requests fit per minute. Same mechanism, different optimization gradient.

### Stream-lifecycle hazards
- Aborted streams charge for tokens generated before abort.
- The Claude Code product has shipped a double-bill bug on cancellation (cancel → auto-retry as non-streaming → both billed). pi-sdk's worker loop does not exhibit this behavior; the lever for gvc0 is to verify no future change introduces auto-retry on cancel.

---

## Tensions and open debates

1. **5m vs 1h TTL**: 1h has 2× write cost; profitable only at ≥3 reads per hour. For sparse task scheduling, the 2× write may not be recovered before the next worker fan-out paid the same write again.
2. **defer_loading discovery cost vs cache stability**: each tool discovery is an extra round-trip. Worth it past ~50 tools where most are unused per-task; not worth it for a static 5–10 tool worker.
3. **Compaction inference cost vs replay cost**: depends on remaining turn count. Compaction wins past ~10 turns; full replay cheaper for short tail.
4. **System-only vs full-history caching**: regime-dependent. Worker fleet (parallel ephemeral) → system-only. Planner (single long session) → full-history with anchored compaction.
5. **Workspace isolation reduces cross-environment reuse**: dev + staging + prod under one org no longer share cache (Anthropic since Feb 2026). Concentrate compute in one workspace if cache reuse matters.
6. **`prompt_cache_key` 15 RPM ceiling on OpenAI**: hard architectural cap for high-throughput shared-prefix fleets.
7. **Bedrock CRIS vs cache hit rate**: cross-region routing breaks cache locality. Disable CRIS for cache-sensitive workloads or accept probabilistic hits.
8. **Direct-provider vs proxy layers**: proxies break Anthropic caching reliably (LiteLLM bugs); sticky routing helps OpenAI/Gemini implicit. Single-provider deployments should bypass proxies on cache-critical paths.

---

## Skipped topics (out of scope by design)

- Model routing across smaller/larger models (covered in [tokenmaxxing.md](./tokenmaxxing.md)).
- Skeleton-of-Thought, Chain of Density, TALE, reasoning-budget techniques (covered in tokenmaxxing.md and [prompt-techniques-research.md](./prompt-techniques-research.md)).
- Output-format compression (TOON, TSV, JSON-key shortening) — covered in tokenmaxxing.md.
- RAG architectures, retrieval strategy, semantic-cache tooling (vCache, W5H2) — orthogonal to provider-level prompt+cache.
- Speculative decoding, KV-cache internals at the model level — not exposed at API surface.
- LLM-as-judge / multi-stage routing — application-level, not provider-level.

---

## Follow-up recommendations

### Immediate (within 1 sprint)
1. Land PR-1 (explicit `ttl: "1h"` + four cache-usage fields recorded). Without measurement, no later optimization is verifiable.
2. Audit current worker harness for dynamic content in system prompt; relocate to first user message (PR-2).
3. Add a `tools-fingerprint` integration test in `test/integration/`.

### Short-term (within 1 month)
4. Implement cache pre-warmup + sub-TTL keepalive in `@orchestrator/` (start at ~50 min for 1h TTL; tune by measurement).
5. Add below-minimum guard with WARN logging in `@runtime/context-assembly`.
6. Wire structured outputs (`output_config.format`) on planner DAG-emission calls.
7. TUI surface for per-worker-class cache hit rate.

### Medium-term (within 1 quarter)
8. Server-side compaction (`compact-2026-01-12`) on planner/replanner.
9. Two-breakpoint pattern with rolling-breakpoint logic in long-running agent harnesses.
10. Tool-result clearing `transformContext` extension (post-anchor only).
11. One-time audit of IPC cancel path to confirm no auto-retry-as-non-streaming regression.

### Long-term (when justified by scale)
12. Batch API + 1h cache + warmup pipeline for shared-context evaluation runs.
13. pi-sdk `CacheHint` abstraction (upstream contribution).
14. Investigate `defer_loading` if planner tool surface grows past 20–30 tools.
15. Decision: stay direct-Anthropic for cache-critical paths or invest in fixing proxy compatibility.

### Open questions to revisit
- Does Anthropic publish ITPM exclusion behavior for thinking output tokens, or only input tokens?
- Will Anthropic restore the 1h Claude Code default, or is 5m the new normal?
- Will `prompt_cache_retention` ever land on Azure OpenAI?
- (Resolved: pi-sdk's `streamFn` is wrappable, so beta-header injection like `compact-2026-01-12` and `advanced-tool-use-2025-11-20` is achievable today without an upstream change.)

---

## Sources by cluster

### Cluster A — Anthropic mechanics
- [Anthropic Prompt Caching Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic Rate Limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Batch Processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- [Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude Code TTL Regression #46829](https://github.com/anthropics/claude-code/issues/46829)
- [DEV: TTL change](https://dev.to/whoffagents/anthropic-silently-dropped-prompt-cache-ttl-from-1-hour-to-5-minutes-16ao)
- [The Register: cache confusion](https://www.theregister.com/2026/04/13/claude_code_cache_confusion/)
- [XDA: 1h cache nerf](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/)

### Cluster B — Agent-loop patterns
- [Don't Break the Cache — arXiv 2601.06007](https://arxiv.org/abs/2601.06007)
- [Anthropic Compaction Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Cookbook: Automatic Context Compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)
- [Advanced Tool Use / defer_loading](https://www.anthropic.com/engineering/advanced-tool-use)
- [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
- [ProjectDiscovery: 59% cut](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching)
- [DigitalOcean: Advanced Prompt Caching at Scale](https://www.digitalocean.com/blog/advanced-prompt-caching)
- [SOC Agent Caching — tokesi.cloud](https://tokesi.cloud/blogs/26_04_11_soc_agent_prompt_caching/)
- [Claude Code Compaction Engine](https://barazany.dev/blog/claude-codes-compaction-engine)
- [Lost in the Middle — arXiv 2307.03172](https://arxiv.org/abs/2307.03172)

### Cluster C — Cross-provider
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenAI Prompt Caching Guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI prompt_cache_key thread](https://community.openai.com/t/understanding-prompt-cache-keys-in-query-efficiency/1357382)
- [Azure OpenAI extended retention gap](https://learn.microsoft.com/en-us/answers/questions/5807188/does-azure-openai-support-extended-prompt-cache-re)
- [Gemini Caching Docs](https://ai.google.dev/gemini-api/docs/caching)
- [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini Implicit Caching](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/)
- [Vertex AI Context Caching](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)
- [Bedrock Prompt Caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Effective Bedrock Caching](https://aws.amazon.com/blogs/machine-learning/effectively-use-prompt-caching-on-amazon-bedrock/)
- [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)
- [LiteLLM Caching](https://docs.litellm.ai/docs/completion/prompt_caching)
- [LiteLLM Issue #6229](https://github.com/BerriAI/litellm/issues/6229)
- [OpenRouter Caching Guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

### Cluster D — Non-per-token billing surfaces
- [Cursor June 2025 Pricing](https://cursor.com/blog/june-2025-pricing)
- [Claude Code Rate Limits — Northflank](https://northflank.com/blog/claude-rate-limits-claude-code-pricing-cost)
- [Claude Max Plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
- [GitHub Copilot Usage-Based Billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)
- [GitHub Models Billing](https://docs.github.com/billing/managing-billing-for-your-products/about-billing-for-github-models)
- [Anthropic Billing](https://support.anthropic.com/en/articles/8114526-how-will-i-be-billed)
- [Token-Efficient Tool Use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/token-efficient-tool-use)
- [Gemini API Pricing (Gemma 4 free tier)](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API Rate Limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Mistral La Plateforme Tiers](https://docs.mistral.ai/deployment/ai-studio/tier)
- [Cohere Rate Limits](https://docs.cohere.com/docs/rate-limits)
- [Groq Rate Limits](https://console.groq.com/docs/rate-limits)
- [Cerebras Rate Limits](https://inference-docs.cerebras.ai/support/rate-limits)
- [OpenRouter API Limits](https://openrouter.ai/docs/api/reference/limits)
- [xAI Rate Limits](https://docs.x.ai/developers/rate-limits)
- [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Featherless Plans](https://featherless.ai/docs/plans)
- [HF Inference Endpoints Pricing](https://huggingface.co/docs/inference-endpoints/pricing)
- [Stalled Streams Bug #43295](https://github.com/anthropics/claude-code/issues/43295)
- [pi-agent-core architecture](https://deepwiki.com/badlogic/pi-mono/3-@mariozechnerpi-agent-core)
- [pi-mono Issue #967: cacheRetention](https://github.com/badlogic/pi-mono/issues/967)

---

## Adoption status

Tracks which recommendations from this synthesis have landed in gvc0. Update when status changes; reference the commit so reviewers can audit scope.

Statuses: `done` (fully applied) · `partial` (subset applied; note scope) · `open` (not yet started) · `deferred` (intentionally postponed) · `rejected` (decided against; note reason).

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| R1 — Explicitly set `ttl: "1h"` on tools and system breakpoints | open | — | No `cache_control` markers found anywhere in `src/`; default TTL regression from March 2026 still unmitigated. |
| R2 — Pre-warm cache before worker fan-out | open | — | No sentinel call logic in `@orchestrator/scheduler` or `@runtime/worker-pool`. |
| R3 — System-prompt-only caching for worker harness | open | — | `buildSystemPrompt` returns a flat string; dynamic content (feature name, task ID, worktree path) not yet split into first user message. |
| R4 — Freeze tools array with stability hash | open | — | No tools-fingerprint hash or stability assertion exists in `@agents/planner` or `@agents/replanner`. |
| R5 — Two-breakpoint pattern + server-side compaction for planner/replanner | open | — | No breakpoint logic; `compact-2026-01-12` beta header not wired. |
| R6 — Track all four cache usage fields per turn in `@persistence/` | partial | — | `cacheReadTokens` and `cacheWriteTokens` tracked in `TokenUsageAggregate` and stored in `agent_runs.token_usage` JSON blob; `ephemeral_5m` / `ephemeral_1h` split fields and per-turn granularity not yet captured. |
| R7 — Below-minimum guard in context assembly | open | — | No token-count estimator or `WARN cache_below_minimum` log in context assembly path. |
| R8 — Lock `budget_tokens` for thinking agents at session start | open | — | Extended thinking not yet wired per-phase; guard is a follow-on to enabling it. |
| R9 — Tool-result clearing via `transformContext` hook | open | — | No `transformContext` extension point or post-anchor drop logic. |
| R10 — Track tools-fingerprint × cache-hit-rate per worker class in TUI | open | — | Cache fields exist in `TokenUsageAggregate` but nothing surfaces hit rate or fingerprint drift alerts in TUI view models. |
| R11 — Structured outputs on all known-schema planner/replanner calls | open | — | `output_config.format` not used anywhere in `src/agents/`. |
| R12 — Verify `disable_parallel_tool_use` is never set unless required | open | — | One-time audit not recorded; no assertion in tests. |
| R13 — Verify no auto-fallback on cancellation in worker IPC path | open | — | IPC cancel path audit not yet done; pi-sdk confirmed safe but regression risk unguarded. |
| R14 — Direct provider clients for cache-critical paths | open | — | gvc0 uses pi-sdk directly (no LiteLLM in the path), so this is moot for current setup; relevant if proxy layer is added later. |
| R15 — Use Batch API + 1h cache for shared-context evaluation runs | open | — | Depends on tokenmaxxing R2 (Batch API infrastructure) not yet landed. |
| R16 — Adopt a `CacheHint` annotation in pi-sdk | open | — | Upstream pi-sdk contribution; defers cross-provider portability work until direct-Anthropic caching is proven. |
