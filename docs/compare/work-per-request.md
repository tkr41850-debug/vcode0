# Work-Per-Request Prompt Techniques

Maximizing useful work per HTTP call when **the call count is metered** (RPD/RPM) but **tokens within each call are free or generous**. The companion to [`tokenmaxxing.md`](./tokenmaxxing.md) and [`provider-tokenmaxxing.md`](./provider-tokenmaxxing.md), which optimize per-token economics. This doc inverts the gradient.

Two-phase research (April 2026): one discovery agent mapped the technique landscape into 12 areas, then four parallel deep-dive agents covered in-call work multiplication, volume packing, multi-task structuring, and quality cliffs. The findings are synthesized below into a ranked priority list, a decision tree, three concrete templates, and source citations.

## 1. Why this regime exists

Per-token billing rewards terseness, RAG, caching, and short focused turns. Per-request billing **inverts every one of those levers**. Real surfaces in 2026:

| Provider / tier | Shape | Notes |
|---|---|---|
| Gemma 4 on Gemini API | No paid tier; free only | The canonical request-denominated model — there is no token meter at all |
| Gemini API free | 2.5 Pro 5 RPM/100 RPD; 2.5 Flash 10 RPM/250 RPD; 2.5 Flash-Lite 15 RPM/1000 RPD | December 2025 cut quotas 50–80% |
| GitHub Models marketplace | 10 RPM / 50 RPD high-tier; 8K input / **4K output hard cap** | Cap is so tight long-output techniques are off the menu |
| Cohere trial | 1000 calls/month total; 20/min Chat, 5/min Embed | Best for batch classification |
| OpenRouter `:free` | 50 RPD without credits, **1000 RPD with $10 deposit** | `:exacto` tool-calling / `:nitro` throughput / `:floor` price variants |
| xAI Grok free | 10 prompts per 2 hours | Tightest in the table |
| Groq | 30 RPM / 14,400 RPD | Token-quota present but generous; effectively request-bounded for most users |
| Cerebras | 30 RPM / 1M tokens-per-day | Token-quota dominates, request-bounded secondary |

The binding constraint becomes: **how much useful, parseable, actionable work can a single round-trip produce before quality degrades?** That is the question this document answers, technique by technique.

## 2. The 12-area taxonomy

| # | Area | Lever |
|---|---|---|
| 2.1 | Multi-task batching | N independent sub-tasks per call |
| 2.2 | Single-call CoT / reasoning models | Spend the response budget on hidden reasoning |
| 2.3 | Output maximization | Push the response to its provider ceiling |
| 2.4 | In-call agentic loops | Encode N agent turns as one response |
| 2.5 | Multi-output / parallel-style prompting | Generate K candidates and aggregate inline |
| 2.6 | Many-shot ICL | Use the input budget for hundreds-thousands of examples |
| 2.7 | Mega-prompts / constraint stacking | Front-load every rule, edge case, and rubric |
| 2.8 | In-call self-verification | Generate then check inside the same response |
| 2.9 | Long-context exploitation | Whole-codebase / whole-document substitution for RAG |
| 2.10 | Output-format levers | Pick formats that pack more parseable deliverables per call |
| 2.11 | Per-provider knobs | thinkingBudget, reasoning_effort, effort, output beta headers |
| 2.12 | Anti-patterns and failure modes | Where every technique above breaks |

The four-cluster split that follows treats these as orthogonal axes: A (in-call multiplication of *logical* calls), B (volume packing on input/output), C (parallel work on multiple tasks), and D (the synthesis layer that maps where each technique breaks).

## 3. Cluster A — In-call work multiplication

The goal: encode work that would otherwise be N HTTP calls into one response.

### 3.1 Reasoning mode and thinking budgets

The classic single-call CoT lever is **Plan-and-Solve+** ([Wang et al. 2305.04091](https://arxiv.org/abs/2305.04091)) — "understand, plan, execute, extract" all in one prompt. PS+ improves over zero-shot CoT by ~5% on math/symbolic tasks; on GPT-4 zero-shot, with self-consistency layered on, GSM8K hits 97.1%. **Least-to-Most** ([Zhou et al. 2205.10625](https://arxiv.org/abs/2205.10625)) decomposes ordered subproblems within a single prompt — but [DISC, 2025](https://openreview.net/pdf/8e6f80833c03da451fac1cb9faac6f430ef6d525.pdf) shows decomposition reliably helps small/mid models (≤70B) and **shows diminishing or negative returns on frontier models**. Don't manually decompose for GPT-5/Claude 4.7/Gemini 3 Pro — let their reasoning mode do it.

Provider knobs (April 2026):

| Provider | Knob | Range | Notes |
|---|---|---|---|
| Gemini 2.5 Pro | `thinkingBudget` | 128–32,768 | -1 = dynamic |
| Gemini 2.5 Flash | `thinkingBudget` | 0–24,576 | 0 disables; -1 dynamic |
| Gemini 2.5 Flash-Lite | `thinkingBudget` | 0/512–24,576 | 0 disabled by default |
| Gemini 3 Pro | `thinkingLevel` | low / high | No raw token knob — three-tier control |
| Claude Opus 4.7 / Sonnet 4.6 | `effort` (adaptive) | low / medium / high / xhigh | `budget_tokens` deprecated on 4.6+ |
| Claude (Batch beta) | `task-budgets-2026-03-13` | up to 128k | Whole agentic-loop budget |
| OpenAI o-series, GPT-5.4/5.5 | `reasoning_effort` | minimal / low / medium / high / xhigh | `xhigh` requires deep `max_completion_tokens` headroom |

Three findings dominate the literature:

1. **Output-token starvation is real.** Claude requires `max_output_tokens > thinking_budget`; Gemini and GPT-5 both can silently produce empty visible output if `max_completion_tokens` is small relative to effort ([googleapis/python-genai #782](https://github.com/googleapis/python-genai/issues/782), [OpenAI community 1378362](https://community.openai.com/t/gpt-5-4-ignores-reasoning-effort-none-when-max-completion-tokens-is-used/1378362/5)). Practical rule: **`max_output_tokens ≥ thinking_budget + 4096`**, and if effort is `high`/`xhigh`, leave 4× the visible-output headroom.
2. **Logarithmic returns then flat.** On GSM8K, raising scratchpad 512→2048 takes accuracy 68.2 → 75.9%; doubling again is mostly noise ([Test-time scaling 2408.03314](https://arxiv.org/html/2408.03314v1)).
3. **Overthinking degrades.** "Does Thinking More Always Help?" ([2506.04210](https://arxiv.org/html/2506.04210)) shows accuracy rises 82.2 → 87.3% then **drops** past a critical budget. Apple's "Illusion of Thinking" ([apple ml site](https://ml-site.cdn-apple.com/papers/the-illusion-of-thinking.pdf)) reports the same on planning-complexity benchmarks.

### 3.2 In-call agentic loops

**Inline tool simulation.** The model emits `<tool>...</tool>` followed by `<tool_result>...</tool_result>` it writes itself, then continues. Works because every frontier model has trained on millions of ReAct/Cursor/Claude-Code traces. Collapses an N-turn ReAct loop ([Yao 2210.03629](https://arxiv.org/abs/2210.03629)) into one response.

In-call beats real ReAct when:
- Tools are deterministic and cheap to mentally model (string transforms, math, simple SQL)
- Budget is request-bounded
- Model is reasoning-class

Collapses when:
- Tools are **non-deterministic** (web search, current data) — model invents plausible-but-wrong results
- Horizon exceeds ~5 simulated steps — drift compounds
- Tools have side effects — simulation describes actions that never happened. Inverse failure: the [2026 Cursor production-DB-deletion incident](https://www.theregister.com/2026/04/27/cursoropus_agent_snuffs_out_pocketos/), where the agent treated real tools like simulated ones.

Production examples (2026): Cursor's leaked ~6K-token agentic prompt; Claude Code's `query()` async generator (per the [2026-03-31 source-leak analysis](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/), only 1.6% of the codebase is AI decision logic — the rest is deterministic plumbing); Aider Architect's planner+editor split.

### 3.3 In-call self-verification — handle with care

**The most important finding in this cluster.** [Stechly et al. 2402.08115](https://arxiv.org/abs/2402.08115) and [Huang et al. ICLR 2024 (2310.01798)](https://arxiv.org/abs/2310.01798) show that without external feedback, **intrinsic self-correction frequently degrades performance**. Earlier reported gains were almost entirely from oracle ground-truth labels leaking into critique prompts. Increasing iterations *raises* Expected Calibration Error — the model gets more confident without getting more right.

When in-call verification helps:
- **External, concrete rubric** (style guide, factual list, unit tests stated in the prompt). The rubric must be checkable against the *original problem*, not against the model's draft.
- **CoVe pattern** ([Dhuliawala 2309.11495](https://arxiv.org/abs/2309.11495)): draft → plan verification questions → answer them *independently without seeing the draft* → revise. The independence mechanic is the load-bearing piece.

When it hurts:
- Self-generated rubric ("is this answer good?") — the critique mirrors the answer's biases.
- Code without execution feedback ([CYCLE, SPLASH 2024](https://2024.splashcon.org/details/splash-2024-oopsla/15/CYCLE-Learning-to-Self-Refine-the-Code-Generation)).
- Tasks the model can't solve in the first place — self-critique cannot rescue a base model that lacks the capability.

### 3.4 Single-call multi-output (in-call self-consistency, BSM, ToT)

**Self-Consistency** ([Wang 2203.11171](https://arxiv.org/abs/2203.11171)) — sample K reasoning paths, vote. The in-call version asks the model to write K independent attempts, then vote. **Branch-Solve-Merge** ([Saha 2310.15123](https://arxiv.org/abs/2310.15123), NAACL 2024) — branch into sub-tasks, solve each, merge: **+26% human-LLM agreement** and **−50% length/position bias** on evaluation tasks. Lets LLaMA-2-chat match GPT-4 on most judging domains. **Skeleton-of-Thought** ([Ning 2307.15337](https://arxiv.org/abs/2307.15337)) — emit a numbered skeleton, expand each point.

The K curve, empirically:
- K=1 → K=5: large gain (+10–15 points typical)
- K=5 → K=20: meaningful (+3–6)
- K=20 → K=40: marginal (+1–2)
- K>40: noise

**K=5 is the practical sweet spot** for free-tier use; CISC ([2502.06233](https://arxiv.org/html/2502.06233v1)) and Soft-SC achieve K=20 quality at K=10 by weighting votes by confidence. **Critical 2025 finding**: parallel scaling does NOT suffer the overthinking cliff that sequential scaling does ([Mirage of Test-Time Scaling, 2506.04210](https://arxiv.org/html/2506.04210)) — accuracy keeps rising or stays flat. This makes parallel-style prompting **the safest large work-multiplier**.

In-call sampling fails when the model **anchors** — later "independent" attempts mirror the first. Mitigation: explicitly demand "use a *different approach* from any previous attempt" and require an `APPROACH N USED:` label per attempt.

### 3.5 Cluster A ROI ranking

1. **Reasoning mode + thinking budget.** 1 call ≈ 5–20 normal calls of "thinking depth." Highest absolute lift on math/code/logic. Cliff: overthinking on simple problems.
2. **In-call parallel sampling (K=5 SC or BSM)** with explicit diversity instruction. Reliable +5–15 points. No overthinking cliff.
3. **In-call agentic loops** — only when tools are deterministic and horizon ≤ 5.
4. **Self-Refine / CoVe** — only with externally-anchored rubric. Without it, expected lift ≈ 0 and may be negative.

## 4. Cluster B — Volume packing

### 4.1 Long output

[LongWriter (Bai et al. 2408.07055, ICLR 2025)](https://arxiv.org/abs/2408.07055) established the ~2K-word ceiling on most production models is **not architectural — it is a function of SFT data**. AgentWrite plans the structure, allocates word counts per paragraph, and generates sequentially; this took GPT-4o from a 2K-word practical ceiling to ~20K. Training on LongWriter-6k unlocked native >10K-word coherent generation in base models. **You can reproduce AgentWrite's gains via prompting alone**, even on models whose SFT ceiling is low.

Anti-truncation patterns:
- **Length contract** in the opening ("Section 1 ~1,500 words, Section 2 ~2,000 words, ...").
- **Plan first, content second.** The two-phase structure prevents collapse toward a short summary.
- **End sentinel** (`</END_OF_RESPONSE>`) plus instruction "do not output the sentinel until every section is complete." Combined with a `finish_reason: length` check, gives a deterministic truncation detector.
- **No-summary clause.** "Do not summarize. Each section must be written at full target length even if earlier sections went long."

Symptom map:
- 2–4K tokens: format adherence solid
- 4–8K tokens: drift accelerates; section headings shift, schema fields get dropped
- 8K+ tokens: repetition loops emerge as the model conditions on its own repetitive outputs ([2512.04419 Solving LLM Repetition in Production](https://arxiv.org/html/2512.04419v1))

### 4.2 Many-shot ICL

[Agarwal et al. NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/8cb564df771e9eacbfe9d72bd46a24a9-Paper-Conference.pdf): performance scales nearly monotonically with shot count into the hundreds-thousands. Translation on Gemini 1.5 Pro: many-shot beats NLLB (35% chRF2++ on Bemba) and Google Translate (40% on Kurdish). With the entire dev set as in-context examples, +15.3% on Bemba and +4.5% on Kurdish vs. 1-shot. Gemini 1.5 Pro starts below Claude-3 on Bemba but **overtakes at ~997 shots**.

[Many-shot jailbreaking (Anthropic 2024)](https://www.anthropic.com/research/many-shot-jailbreaking) is the same mechanism: useless at 5 shots, consistent at 256, follows predictable scaling laws. The mitigation work ([2504.09604](https://arxiv.org/html/2504.09604v3)) drove attack success from 61% to 2% via targeted training — legitimate task shots are not affected.

The 2022 PEFT-beats-ICL result ([Liu et al. 2205.05638](https://arxiv.org/abs/2205.05638)) is **decisively inverted under free-tier constraints**. PEFT requires upfront training cost, GPU access, infrastructure; ICL costs zero when tokens are free. Break-even in 2026: if you'd issue >10K inference calls and have labeled data, fine-tune. Below that, many-shot wins.

Knee: returns flatten beyond ~500 shots; after ~1000, improvements are noise. Knee is task-dependent — translation, classification, code show monotone gains further out; open-ended generation flattens earlier.

### 4.3 Mega-prompts / constraint stacking

Productionized mega-prompts (2025–2026) live publicly in [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks) (Claude Code, Opus 4.7/4.6, Sonnet 4.6, Gemini 3.1 Pro, Grok 4.3 beta) and [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) (Cursor, Devin, Windsurf, Lovable, v0). The pattern is consistent: persona + capability declaration; tool descriptions in full; style and format rules; edge cases and refusal triggers; mistake/success example pairs; verification rubric. Cursor and Claude Code prompts run **8K–20K+ tokens**.

Failure modes:
- **Refusal cascade.** Stacking too many "do not" rules with overlapping scope → hyper-cautious refusals on benign inputs. Mitigation: paired affirmative + negative ("do X; do not do Y when Z").
- **Instruction drift.** Beyond ~12K tokens of mixed system instructions, models begin selectively ignoring middle-positioned rules.
- **Conflicting precedence.** When two rules collide, models often pick whichever was stated last. Restate top-priority rules at start *and* end.

### 4.4 Long-context exploitation — the largest free-tier multiplier

**Effective vs. claimed gap is large in 2026.** Two benchmarks set the floor:

- [RULER (NVIDIA, arXiv 2404.06654)](https://arxiv.org/abs/2404.06654): of models claiming ≥32K, only ~half maintain satisfactory performance at 32K. Effective capacity averages **60–70% of advertised**.
- [NoLiMa (Adobe Research, ICML 2025, arXiv 2502.05167)](https://arxiv.org/abs/2502.05167): when needles share no lexical overlap with queries, GPT-4o drops 99.3% → 69.7% at 32K. **At 32K, 11 of 13 tested models fall below 50% of their short-context baseline.** CoT and reasoning don't rescue this.
- [Chroma "context rot"](https://www.morphllm.com/context-rot) on 18 frontier models: **20–50% accuracy drop from 10K to 100K**, even on perfect-retrieval tasks. Claude decays slowest, but no model is immune.
- [Context Length Alone Hurts LLM Performance](https://nrehiew.github.io/blog/long_context/) (2025): 13.9–85% degradation purely from context length, **persisting even when irrelevant tokens are masked** — proving it's not just attention-distractor.

**Whole-codebase / whole-document substitution** is the highest-ROI pattern under request-bounded billing. Feed the entire repo + question + rubric + output format in one call. Avoids retrieval failure modes. Cap at the model's *effective* (not claimed) context. **Plan capacity at 0.5–0.7× advertised** as a default.

### 4.5 Provider matrix (April 2026)

| Provider | Model | Max context | Effective | Max output | Reasoning knob |
|---|---|---|---|---|---|
| Anthropic | Opus 4.7 | 200K | ~140K | 64K (300K Batch beta) | `effort` low/med/high/xhigh, adaptive |
| Anthropic | Sonnet 4.6 | 1M (beta) | ~700K | 64K (300K Batch beta) | same |
| Google | Gemini 2.5 Pro | 1M | ~800K | configurable | `thinkingBudget` |
| Google | Gemini 2.5 Flash-Lite | 1M | ~600K | configurable | `thinkingBudget` |
| Google | Gemini 3 Pro | 1M+ | ~800K | configurable | `thinkingLevel` (3-tier) |
| OpenAI | GPT-5.4 | 1.05M | ~700K | 128K | `reasoning_effort` 5-level |
| OpenAI | GPT-5.5 | 922K input | ~600K | 128K | same |
| Meta | Llama 4 Scout | 10M (claimed) | ~1M actual | model-dep | n/a; OpenRouter `:free` |
| xAI | Grok 4.3 | 384K (Think Max) | ~250K | model-dep | Think Max mode |
| DeepSeek | V4 Pro / Flash | 1M | ~600K | model-dep | thinking + effort |
| GitHub Models | various | 8K input | 8K | **4K hard** | n/a |
| Cohere | Command R+ | 256K | ~150K | 8K typical | n/a |
| OpenRouter | `openrouter/free` | 200K | ~140K | model-dep | `effort_ratio` 0.1–0.95 |

**Anthropic Batch API + `output-300k-2026-03-24` beta** = 300K max output (~225K English words in one call). Use Batch API for long-output jobs; the sync API will refuse past its tier.

### 4.6 Cluster B ROI ranking

| Rank | Technique | Multiplier | Best on |
|---|---|---|---|
| 1 | Whole-codebase / whole-doc analysis (replaces RAG pipeline) | 10–100× | Gemini 2.5/3 Pro, Claude (1M beta), Llama 4 Scout |
| 2 | AgentWrite-style structured long output | 5–10× | Claude Batch (300K), GPT-5 (128K), Gemini |
| 3 | Many-shot ICL (200–1000 shots) | 3–8× accuracy | Gemini 2.5 Pro, Claude Opus, Llama 4 Scout |
| 4 | Mega-prompt with constraint stack | 2–5× (fewer iterations) | Any model with ≥32K context |
| 5 | Reasoning-effort knob tuning | 1.2–2× quality | Claude xhigh, Gemini high, GPT-5 xhigh |

## 5. Cluster C — Multi-task structuring

### 5.1 Batch prompting

[Cheng et al. 2301.08721, EMNLP 2023](https://arxiv.org/abs/2301.08721): K=6 on Codex gave ~5× token/time reduction across 10 datasets at parity-or-better quality.

[BatchPrompt 2309.00384, ICLR 2024](https://arxiv.org/abs/2309.00384) is the empirical knee study:
- BoolQ at K=64: accuracy crashes from 90.6% to **72.8%** (18-point cliff)
- **Batch Permutation and Ensembling (BPE)** — re-run in 5–7 different orderings, majority-vote per item — recovers BoolQ@64 to 82–86%, and at K=32 with 5 voting rounds achieves **90.9% (vs 90.6% baseline) at 27.4% of baseline tokens**
- **SEAS (Self-reflection-guided Early Stopping)**: ~80% of items resolved in 2 voting rounds. End-to-end uses **15.7% of the LLM calls** of the unbatched baseline — directly relevant when the meter is RPD
- QQP@32: 88.4% (vs 87.2%) at 18.6% of tokens; RTE@32: 91.1% at 30.8%

The cliff is dominated by **position effects within the batch** — tokens far from the task spec attend less. The cliff worsens with longer per-item content.

### 5.2 Architecture-dependence

[MDPI Electronics 14(21):4349, Nov 2025](https://www.mdpi.com/2079-9292/14/21/4349) packed JSON formatting + EN-IT translation + sentiment + emotion + topic + NER into one prompt across six small open models:

- **Qwen3 4B**: stable across all six combined
- **Gemma 3 4B and Granite 3.1 3B**: severe collapse on fine-grained semantic tasks once 3+ tasks combined
- **Llama 3.1 8B and DeepSeek-R1 7B**: **positive transfer** — some tasks *improve* in the multi-task setting
- ~50% of multi-task failures are "instruction-order violations and semantic drift" ([Order Effect 2502.04134](https://arxiv.org/html/2502.04134v2)); up to 72% accuracy drop under non-sequential conditions
- The "curse of instructions" ([2507.11538](https://arxiv.org/html/2507.11538v1)): joint constraint satisfaction probability decays multiplicatively with constraint count

**Practical knee**: small open models (≤4B) start collapsing at **N≈3–4** semantically distinct tasks. Frontier models hold past **N≈10** if tasks are independent and outputs are clearly delimited. There is no universal N — measure per (model, task family).

### 5.3 Branch-Solve-Merge for parallel sub-tasks

[Saha et al. 2310.15123, NAACL 2024](https://arxiv.org/abs/2310.15123) is purpose-built for cases where sub-tasks share a common input but require *different evaluative lenses* (grade an essay on coherence, factuality, style). Pure batch assumes independence; BSM assumes *parallel evaluation of one input*. Practical rule: **if you can write the K sub-prompts before knowing the answers, batch or BSM both work. If sub-task k+1's prompt depends on sub-task k's answer, you need chaining (multi-call), not multi-task structuring.**

### 5.4 Format levers — the critical Tam et al. result

[Tam et al. 2408.02442 "Let Me Speak Freely?"](https://arxiv.org/html/2408.02442v1) — the most important format paper for batching:

| Task | Model | Free-text | JSON-mode | Δ |
|---|---|---|---|---|
| GSM8K | Claude-3-Haiku | 86.5% | **23.4%** | −63 |
| Last Letter | GPT-3.5-Turbo | ~57% | 25% | −32 |
| Last Letter | LLaMA-3-8B | 70% | 28% | −42 |
| DDXPlus (classification) | Gemini | 41.6% | **60.4%** | **+19** |

**Strict format constraints hurt reasoning** (force premature commitment to answer tokens before reasoning tokens) but **help classification** (discipline the output space). Mitigation: **NL-to-Format** — free reasoning first, structured serialization second. Anthropic's structured-outputs guidance: put `reasoning` field *first* in JSON, `answer` *last*; reversing them turns the chain-of-thought into post-hoc rationalization.

**XML in, JSON out.** Anthropic explicitly recommends XML tags (`<task1>`, `<input>`, `<context>`) for delimiting prompt sections — they survive tokenizer ambiguity better than JSON braces and are visually unambiguous when content contains JSON. JSON is preferred for output (machine-parseable).

### 5.5 Density crossover

| K | Format | When |
|---|---|---|
| ≤5, heterogeneous | XML-tagged sections | Per-task delimiters keep instruction-following high |
| 5–30, homogeneous | JSON array, one object per item | Minimal per-item overhead |
| 30+, homogeneous | NDJSON line-per-item + BPE if quality matters | JSON arrays are fragile (one missing bracket destroys 30 results) |
| Reasoning-heavy any K | Free-text reasoning, JSON serialized at end | Or two-step NL-to-Format |

### 5.6 Use-case → strategy matrix

| Use case | Format | Optimal K |
|---|---|---|
| Bulk classification (sentiment, label, NER) | JSON array, one object per item | 10–30 |
| Bulk Q&A (independent factual) | JSON array `{id, reasoning, answer}` | 5–10 |
| Bulk transformation (rewrite, translate) | JSON array of `{id, output}` | 10–20; watch cross-contamination on similar inputs |
| Bulk evaluation (one rubric, N candidates) | BSM — branch on rubric criteria | N candidates × M criteria |
| Multi-file codegen | XML-tagged sections, one per file | 3–8 files |

## 6. Cluster D — Quality cliffs and failure modes

The synthesis layer. When call count is the metered resource the temptation is to pack until it hurts; this section maps where "hurts" actually starts.

### 6.1 The empirical knee map

| Technique | Knee shape | Where to stop |
|---|---|---|
| Multi-task batch | Architecture-bound; small opens cliff at N=3–4, frontiers past N=10 | Pilot K=4, K=8, K=16 on your model+task |
| Long output | SFT-distribution-bound; symptoms at 4–8K, repetition at 8K+ | Use AgentWrite plan-first below ceiling; chunk above |
| Long context | Effective ≈ 0.5–0.7× advertised; quarter that for reasoning | Plan capacity at half advertised |
| Many-shot ICL | Saturates at ~32K-input shots on SSL; sometimes earlier on global-context | Diminishing returns past 500–1000 shots |
| Mega-prompt | 8–15K typical production; refusal cascade past ~20K with conflicting rules | Restate top rules at start *and* end |
| In-call self-verification | Often **negative** without external rubric (Stechly, Huang) | External rubric only |
| Self-consistency in-call | K=5 sweet spot; K=20 marginal; >40 noise | K=5 with diversity enforcement |

### 6.2 The fall-back decision matrix — when 1 big call beats N

| Condition | 1 big call wins | N small calls win |
|---|---|---|
| Tasks share heavy context | ✓ | pays context N× |
| Tasks independent | tie up to model's batch tolerance | ✓ past that knee |
| Output budget per task > ~2K | | ✓ (avoids long-output cliff) |
| Reasoning depth > shallow | | ✓ (preserves token-budget for thinking) |
| Failure of one contaminates others | | ✓ (isolation) |
| Calls metered, tasks cheap | ✓ (this scenario) | |
| Need streaming / early-abort | | ✓ (smaller blast radius) |
| Task outputs feed each other | ✓ (single coherent state) | |

**Inversion rule**: math flips when (a) total expected output × number of tasks crosses the long-output knee (~4–8K most), (b) task count exceeds model's batch tolerance (3–4 sub-7B, ~10 frontier), or (c) any task requires deep reasoning whose hidden tokens compete with visible-output budget for the rest.

**Sweet spot for free tiers**: pack 5–10 independent tasks of ≤1K output each into one frontier-model call; pack 2–3 into a small open model; never batch tasks where one's failure invalidates the others.

### 6.3 Silent-failure detection checklist

Assert on every response when packing near the cliff:

1. **`finish_reason` discipline.** Treat `length`, `max_tokens`, `MAX_TOKENS`, and provider-specific equivalents as hard failures. The [LiteLLM/ADK bug](https://github.com/google/adk-python/issues/4482) silently drops tool-call responses on `finish_reason: length`.
2. **Output-token watermark.** If `usage.completion_tokens` ≥ 95% of `max_output_tokens`, treat as truncated even if `finish_reason` says `stop` — some providers misreport ([OpenAI community report](https://community.openai.com/t/max-tokens-not-set-truncated-return-with-finish-reason-stop/725740)).
3. **Schema validation per task slot.** Multi-task batches: validate each slot independently. **Later slots fail more often** (order effect).
4. **Repetition check.** Sliding-window n-gram repetition over last 512 tokens. If any 4-gram repeats >5×, abort and chunk.
5. **Reasoning-token starvation.** Gemini and GPT-5: when `reasoning_tokens` approaches `thinkingBudget` and `completion_tokens` is small, the visible answer was starved. Re-run with larger output budget.
6. **Refusal / partial refusal markers.** "I cannot", "I'm unable", and provider-specific safety-cut signals; mid-stream content-filter trips can leave half-formatted JSON.
7. **Token-count reconciliation.** Compare local tokenizer's count vs. provider's reported `prompt_tokens`. Anthropic Opus 4.7's new tokenizer can produce 35% more tokens per same input ([Finout 2026](https://www.finout.io/blog/claude-opus-4.7-pricing-the-real-cost-story-behind-the-unchanged-price-tag)).
8. **429 cascade isolation.** A retry budget burned on rate-limit errors should not be charged against the request's logical retry count.
9. **Per-slot length parity.** In multi-task batches, slot N dramatically shorter than slot 1 → drift. Set per-slot min-length asserts.
10. **JSON-mode reasoning loss.** [Tam et al. 2024](https://arxiv.org/html/2408.02442v1): up to 60-point drops on math/symbolic when locked into JSON mode. If a slot needs reasoning, interleave a `<thinking>` free-form section *inside* the JSON-emitting prompt.

### 6.4 Operational patterns near the cliff

- **Streaming-abort with checkpointing.** Persist tokens as they stream. On repetition, schema break, or slot corruption, abort and resume with "continue from `<last good slot>`."
- **NDJSON-per-slot** beats JSON arrays in batches. A missing closing bracket destroys all 10 results in an array; NDJSON loses only the broken line.
- **Plan/execute split (LongWriter pattern).** Don't ask one call for 10K words. Ask for an outline first, then per-section continuation if you trust the model, or per-section calls if you don't.
- **External-verifier pattern.** Stechly et al. show same-model self-critique is anti-helpful. With two free-tier accounts on different providers: model A produces, model B critiques. The asymmetry (B never saw A's reasoning chain) is what makes the critique informative.
- **Eval signals that catch drift before it ships.** Hold out a 50–100 example fixed eval set; track per-slot accuracy in batches; **last-slot accuracy** is the leading indicator of order-drift; track p95 output length; track schema-validation-failure rate at the 99th percentile.

### 6.5 Provider-cliff guardrails (April 2026)

- **GitHub Models**: hard 4K output, 8K input, 50 RPD high-tier, 10 RPM, 2 concurrent ([Discussion 149698](https://github.com/orgs/community/discussions/149698)). Never attempt long output here.
- **Anthropic**: Sonnet 4.6 / Haiku 4.5 = 64K output; Opus 4.6 = 128K; Batch API + `output-300k-2026-03-24` = 300K. Use Batch API for long-output jobs.
- **Gemini 2.5/3**: thinkingBudget 0–24,576 (hidden, billed). When budget exhausts, the model breaks the thought chain and ships whatever it has — predictable, but degraded answer with no error.
- **GPT-5 family**: `reasoning_effort=xhigh` + tight `max_completion_tokens` = silent empty output. Always set `max_completion_tokens ≥ 4× expected visible output` when effort is high.
- **OpenRouter `:free`**: rate-limit behavior is graceful-degrade-then-429; some providers downgrade to a smaller model silently — check the response's `model` field.

## 7. Synthesis: ranked priorities

Combining all four clusters, ordered by work-multiplication per call for a developer hitting request-based billing:

| # | Lever | Multiplier | Cluster | Cliff |
|---|---|---|---|---|
| 1 | Whole-codebase / whole-doc analysis (replaces RAG) | 10–100× | B | NoLiMa drop past 0.5× advertised context |
| 2 | Reasoning mode + thinking budget at `high`/`xhigh` | 5–20× depth | A | Overthinking past saturation; output-token starvation |
| 3 | AgentWrite-style structured long output | 5–10× | B | Format collapse past 4–8K; repetition past 8K |
| 4 | In-call parallel sampling K=5 with diversity enforcement | +10–15 pts accuracy | A | K>20 marginal; anchoring without diversity instruction |
| 5 | Multi-task batching K=5–10 (frontier) / K=3–4 (small open) | N× | C | Architecture-dependent collapse on fine-grained semantics |
| 6 | Many-shot ICL (200–1000 shots) | 3–8× accuracy | B | Saturation past ~500; NoLiMa hits at high counts |
| 7 | Mega-prompt with constraint stack | 2–5× fewer retries | B | Refusal cascade past ~20K; instruction drift past ~12K |
| 8 | In-call agentic loop (deterministic tools, ≤5 steps) | 5–10× call collapse | A | Drift past 5 steps; non-deterministic tools |
| 9 | BSM for multi-criterion evaluation | −50% position bias | C, A | Only when sub-tasks are parallel evaluations of one input |
| 10 | External-rubric CoVe (NOT intrinsic self-refine) | 3:1 call collapse on fact-check | A | Negative without external rubric |

### 7.1 Decision tree

```
Is the work one task with one answer?
├── Yes → Reasoning mode high + Plan-Execute-Verify-Revise (Template A) +
│         (if closed-form) K=5 self-consistency (Template B)
└── No, multiple tasks
    ├── Tasks independent of each other?
    │   ├── Yes, homogeneous → JSON array batch, K=5–10 frontier / K=3–4 small open
    │   ├── Yes, heterogeneous (≤5) → XML-tagged sections
    │   └── No, dependencies between → multi-call chain (not batch)
    └── Tasks are parallel evaluations of one input → BSM template

Is output > 4K tokens?
├── No → fine
├── Yes, <64K → standard sync API with anti-truncation template + sentinel
└── Yes, >64K → Anthropic Batch API + output-300k beta header

Is input the bulk of the work?
├── Lots of examples → Many-shot ICL up to ~70% of effective context
├── Whole codebase → cap at 0.5–0.7× advertised context; restate critical rules at top + bottom
└── Both → mega-prompt; restate top-priority rules

Need verification?
├── External rubric available (tests, fact list, style guide) → in-call CoVe with independent-question pattern
└── No external rubric → don't bother. Use a different model as critic instead.
```

### 7.2 Specific recommendations per free-tier budget

- **Gemini API free (Flash-Lite, 1000 RPD)** — whole-document analysis first; the 1M context with implicit caching (90% cached-input discount) is the killer feature. `thinkingBudget` high. Use Template A (long output).
- **Gemini 2.5 Pro free (100 RPD)** — high-stakes only. Many-shot ICL at 500–1000 shots fits cleanly. Verify with high `thinkingBudget`.
- **OpenRouter `:free` (50 RPD; 1000 with $10)** — `:exacto` for tool-calling; `effort_ratio: 0.95` for hard reasoning. Mega-prompt approach (Template C) works because input is free.
- **GitHub Models (4K output cap)** — do NOT attempt long output. Best for short classification/extraction. Many-shot ICL works for input-heavy tasks (8K input).
- **Cohere trial (1000/mo)** — batch classification, embeddings, rerank. Many-shot ICL on Command R+ at moderate counts.
- **Claude (Batch API at 50% off)** — when you need 64K+ output, **always Batch + `output-300k-2026-03-24`**. Pair `effort: xhigh` + adaptive thinking for hardest tasks.
- **Llama 4 Scout via OpenRouter** — only for genuinely massive context (>1M). 60s+ first-token latency makes it a poor default.

## 8. Templates

### 8.1 Template A — Plan-Execute-Verify-Revise single-call

```
You will solve the problem in a single response with four labeled phases.
Do not skip phases.

[PHASE 1 - PLAN]  Write a numbered plan of 3-7 steps. Identify any
   sub-problem solvable independently and mark it [PARALLEL]. Identify
   the verification rubric you will use in PHASE 3 — it must be checkable
   against the problem statement, NOT against your own draft.

[PHASE 2 - EXECUTE]  Walk the plan. For [PARALLEL] steps, write each
   independently before combining. Emit a draft labeled DRAFT:.

[PHASE 3 - VERIFY]  Generate 3-5 verification questions about DRAFT.
   Answer each ONLY using the original problem statement — do not look
   at your DRAFT while answering. List failures.

[PHASE 4 - REVISE]  Produce FINAL: by applying every failure from PHASE 3.
   If PHASE 3 found no failures, FINAL: equals DRAFT:.

Problem: <YOUR_PROBLEM>
```

### 8.2 Template B — In-call self-consistency with diversity enforcement (K=5)

```
Solve this problem 5 times, using a meaningfully different approach each time.

After attempt N, briefly state "APPROACH N USED: <one-line description>".
Subsequent attempts MUST use a different APPROACH label. If you cannot
find 5 distinct approaches, say so and stop.

Format each attempt as:
=== ATTEMPT N ===
APPROACH N USED: <label>
<reasoning>
ANSWER N: <final answer in canonical form>

After all 5 attempts:
=== VOTE ===
List each unique ANSWER and how many attempts produced it. The WINNING
ANSWER is the one with most votes. If tied, pick the one whose reasoning
has fewest arithmetic/logical errors when re-checked.
Output: FINAL: <winning answer>.

Problem: <YOUR_PROBLEM>
```

### 8.3 Template C — Anti-truncation long-output

```
You will produce a [DOCUMENT_TYPE] of approximately [N] words total.

Plan first, then write. Output exactly this structure:

<PLAN>
1. [Section title] - target ~[X] words - covers [...]
2. ...
</PLAN>

<DRAFT>
## 1. [Section title]
[Full content. Do not summarize. Do not abbreviate. Target ~[X] words.
If you reach that count and the section is incomplete, continue past
the target — never cut early.]

## 2. ...
</DRAFT>

<END_OF_RESPONSE>

Rules:
- Do not output </END_OF_RESPONSE> until every section in <PLAN> has
  been written in <DRAFT> at full target length.
- If a section runs long, that is acceptable. If it runs short, expand
  it before moving on.
- No meta-commentary, no recap.
- If you sense you may be approaching a length limit, finish the current
  sentence and emit </CONTINUE_NEEDED> instead of stopping silently.
```

Client logic: if response ends without `</END_OF_RESPONSE>` or contains `</CONTINUE_NEEDED>`, re-issue with the partial completion plus "continue exactly where you stopped, no recap."

### 8.4 Template D — XML-tagged multi-task prompt (heterogeneous K≤5)

```
You will perform 4 independent tasks on the article below. Emit exactly
one section per task. No prose outside the tags.

<article>{ARTICLE}</article>

<task1 name="summary">Three-sentence summary.</task1>
<task2 name="entities">JSON array of named entities with type.</task2>
<task3 name="sentiment">One word: positive | negative | neutral.</task3>
<task4 name="questions">Three follow-up questions, one per line.</task4>

Now produce:
<output>
  <summary>...</summary>
  <entities>[...]</entities>
  <sentiment>...</sentiment>
  <questions>...</questions>
</output>
```

### 8.5 Template E — JSON-array bulk classification (homogeneous K 10–30)

```
You will classify N customer reviews for sentiment.

Output ONLY a JSON array. Each element:
  {"id": <int>, "sentiment": "positive"|"negative"|"neutral", "confidence": 0..1}.
No commentary outside the array. Output exactly N elements in input order.

<reviews>
1. "Shipping was fast but the product broke in two days."
2. "Absolutely love it, third one I've bought."
...
N. "..."
</reviews>
```

For K > 20, repeat with shuffled order, majority-vote (BPE pattern).

## 9. Relationship to gvc0

gvc0's planner currently runs on Anthropic — per-token, not request-bounded — so the per-call multipliers above don't change the bill directly. But three patterns transfer:

1. **In-call agentic loops (§3.2)** match gvc0's process-per-task model only inversely: gvc0 explicitly chose the multi-call path for isolation. The relevant insight is the failure-mode list — *non-deterministic tools, side-effect tools, horizons >5* — which restates the case for gvc0's design. Document under `docs/concerns/` if not already.
2. **Multi-task structuring (§5)** is directly applicable to the planner agent itself, which already produces multi-task plan output. The K=5–10 frontier knee, NDJSON-per-slot resilience, and order-effect mitigations (BPE for high-stakes batches, restating top rules at end) are concrete wins.
3. **Long-context exploitation (§4.4)** — the 0.5–0.7× effective-context rule and Chroma context rot evidence are load-bearing for any decision about how much repository context to feed the planner. Already partially captured in [`provider-tokenmaxxing.md`](./provider-tokenmaxxing.md); the NoLiMa numbers here are the empirical floor.

For users running gvc0 on a free tier (Gemma 4 + planner-on-Gemini variant), §7.2's per-tier playbook is the operating manual.

## 10. Mindset shifts vs. per-token economics

| Per-token mindset | Per-request (this doc) |
|---|---|
| Minimize input tokens; RAG over stuffing | Stuff the call: whole-codebase, many-shot, mega-prompt |
| Short focused turns | One call per logical task end-to-end |
| Avoid hidden reasoning (it's billed) | Set `effort: xhigh` / `thinkingBudget: high` by default |
| Cache aggressively; reuse system prompts | Cache still helps but is not the binding constraint |
| Modular prompts beat monoliths | Modular beats monoliths in *quality*, but monoliths win on RPD when input is free |
| Batch saves tokens at K=6 | Batch saves *requests* — push K to architecture's knee |
| Self-refine costs another call | In-call CoVe with external rubric collapses 3 calls to 1 |
| JSON mode for parsing | JSON mode for *classification*; free-text for *reasoning*, then serialize |

## 11. Sources

### Foundational papers
- [Plan-and-Solve Prompting (2305.04091)](https://arxiv.org/abs/2305.04091)
- [Self-Consistency (2203.11171)](https://arxiv.org/abs/2203.11171)
- [Tree of Thoughts (2305.10601)](https://arxiv.org/abs/2305.10601)
- [Skeleton-of-Thought (2307.15337)](https://arxiv.org/abs/2307.15337)
- [Branch-Solve-Merge (2310.15123)](https://arxiv.org/abs/2310.15123)
- [Self-Refine (2303.17651)](https://arxiv.org/abs/2303.17651)
- [Reflexion (2303.11366)](https://arxiv.org/abs/2303.11366)
- [Chain-of-Verification (2309.11495)](https://arxiv.org/abs/2309.11495)
- [Least-to-Most (2205.10625)](https://arxiv.org/abs/2205.10625)
- [ReAct (2210.03629)](https://arxiv.org/abs/2210.03629)
- [Batch Prompting (2301.08721)](https://arxiv.org/abs/2301.08721)
- [BatchPrompt + BPE (2309.00384)](https://arxiv.org/abs/2309.00384)
- [LongWriter (2408.07055)](https://arxiv.org/abs/2408.07055)
- [Many-Shot ICL (Agarwal NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/file/8cb564df771e9eacbfe9d72bd46a24a9-Paper-Conference.pdf)
- [Chain of Density (2309.04269)](https://arxiv.org/abs/2309.04269)

### Quality-cliff / failure-mode evidence
- [LLMs Cannot Self-Correct Reasoning Yet — Huang et al. ICLR 2024 (2310.01798)](https://arxiv.org/abs/2310.01798)
- [Self-Verification Limitations — Stechly et al. (2402.08115)](https://arxiv.org/abs/2402.08115)
- [Does Thinking More Always Help? (2506.04210)](https://arxiv.org/html/2506.04210)
- [The Illusion of Thinking — Apple ML](https://ml-site.cdn-apple.com/papers/the-illusion-of-thinking.pdf)
- [Let Me Speak Freely? (2408.02442)](https://arxiv.org/html/2408.02442v1)
- [Multi-Task Degradation (MDPI Electronics 14(21):4349, 2025)](https://www.mdpi.com/2079-9292/14/21/4349)
- [Order Effect (2502.04134)](https://arxiv.org/html/2502.04134v2)
- [How Many Instructions Can LLMs Follow at Once (2507.11538)](https://arxiv.org/html/2507.11538v1)
- [Solving LLM Repetition Problem in Production (2512.04419)](https://arxiv.org/html/2512.04419v1)
- [RULER (2404.06654)](https://arxiv.org/abs/2404.06654)
- [NoLiMa (2502.05167)](https://arxiv.org/abs/2502.05167)
- [Chroma context rot (Morph)](https://www.morphllm.com/context-rot)
- [Context Length Alone Hurts LLM Performance Despite Perfect Retrieval](https://nrehiew.github.io/blog/long_context/)
- [Lost in the Middle (2307.03172)](https://arxiv.org/abs/2307.03172)
- [On Many-Shot ICL for Long-Context (ACL 2025)](https://aclanthology.org/2025.acl-long.1245.pdf)
- [Benchmarking and Defending LLM Batch Prompting Attack (ACL Findings 2025)](https://aclanthology.org/2025.findings-acl.245.pdf)
- [Confidence Improves Self-Consistency (2502.06233)](https://arxiv.org/html/2502.06233v1)
- [Inverse-Entropy Voting (2511.02309)](https://www.arxiv.org/pdf/2511.02309)

### Provider documentation (April 2026)
- [Anthropic — Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Anthropic — Adaptive Thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Anthropic — Effort parameter](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Anthropic — Batch processing (300K output beta)](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic — XML tag prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags)
- [Anthropic — Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic — Many-shot Jailbreaking research](https://www.anthropic.com/research/many-shot-jailbreaking)
- [Gemini API — Thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [Gemini API — Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini API — Caching](https://ai.google.dev/gemini-api/docs/caching)
- [OpenAI — GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)
- [OpenAI — GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)
- [OpenRouter — Reasoning Tokens guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenRouter — free models](https://costgoat.com/pricing/openrouter-free-models)
- [GitHub Models — rate limits discussion](https://github.com/orgs/community/discussions/149698)
- [Cohere — rate limits](https://docs.cohere.com/docs/rate-limits)
- [DeepSeek-V4-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)
- [Llama 4 — Meta](https://www.llama.com/models/llama-4/)
- [Llama 4: Challenges of a Frontier-Level LLM — Cameron R. Wolfe](https://cameronrwolfe.substack.com/p/llama-4)
- [Artificial Analysis Leaderboard](https://artificialanalysis.ai/leaderboards/models)

### Production prompt evidence
- [System prompts leaks (asgeirtj)](https://github.com/asgeirtj/system_prompts_leaks)
- [System prompts of AI tools (x1xhlol)](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [Claude Code system prompts collection (Piebald)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [Claude Code source-leak analysis (alex000kim, 2026-03-31)](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)
- [Cursor production-DB deletion incident — The Register](https://www.theregister.com/2026/04/27/cursoropus_agent_snuffs_out_pocketos/)

### Operational / silent-failure references
- [LiteLLM/ADK finish_reason silent drop bug — google/adk-python #4482](https://github.com/google/adk-python/issues/4482)
- [GPT-5.4 reasoning_effort vs max_completion_tokens — OpenAI community](https://community.openai.com/t/gpt-5-4-ignores-reasoning-effort-none-when-max-completion-tokens-is-used/1378362/5)
- [Anthropic Opus 4.7 tokenizer change — Finout](https://www.finout.io/blog/claude-opus-4.7-pricing-the-real-cost-story-behind-the-unchanged-price-tag)
- [Beyond JSON Mode (TianPan, Oct 2025)](https://tianpan.co/blog/2025-10-29-structured-outputs-llm-production)
