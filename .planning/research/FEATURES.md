# Feature Research

**Domain:** Local autonomous coding orchestrator for power users — prompt-to-green-`main` loop with live steering
**Researched:** 2026-04-23
**Confidence:** HIGH (lineage + comparator features are well understood) / MEDIUM (specific 2026 comparator-version capabilities should be spot-verified before strategic decisions)

> Note on method: research-agent attempts all hit streaming timeouts; this report compiles from PROJECT.md, the in-tree `docs/compare/`, `docs/feature-candidates/`, `ARCHITECTURE.md`, and general ecosystem knowledge.

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these makes the product feel broken to a power user in 2026.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Prompt entry (natural-language goal) | Table stakes for any coding agent; the entire product loop starts here | LOW | Single text box in TUI + optional stdin seed; directly feeds top-level planner |
| Working git integration (branch, commit, push) | Agent coding tools that can't touch git are toys | MEDIUM | Already covered via `simple-git`; feature branches + worktrees are the beating heart |
| Live log / transcript of what the agent is doing | User needs to trust what's happening to let it run autonomously | MEDIUM | Per-task transcript surface (REQ-TUI-01); must stream without flicker |
| Agent pauses to ask questions | Agents that guess silently produce wrong work; asking is the only honest pattern | MEDIUM | Inbox is the unified surface (REQ-INBOX-01) |
| Retry on transient error | Agents running for minutes hit network blips; silent failure is unacceptable | LOW | REQ-EXEC-04 (retry transient, inbox semantic) |
| Cancel mid-run | Users will want to stop work; no escape = fear of launching | MEDIUM | Three cancel levers (REQ-TUI-05) |
| Resume after orchestrator crash | A full-session restart on crash is intolerable once runs take hours | HIGH | Seamless auto-resume (REQ-STATE-02); SQLite + transcript replay |
| Visible cost / token usage | Power users will not run unbounded agents with no meter | LOW-MEDIUM | Pi-sdk provides `usage` per agent run; aggregate and surface in TUI |
| Config editable without restart | Changing the model or worker cap shouldn't require killing in-flight work | MEDIUM | REQ-TUI-04 (config menu in TUI) |
| Safe defaults for destructive ops | Any tool that can `rm -rf` without gates will terrify users | MEDIUM | Approvals surfacing in inbox; worker tool allowlist |
| Deterministic tests (no real LLM calls) | Development of the orchestrator itself is impossible without this | LOW | pi-sdk `fauxModel` already solved this |

### Differentiators (gvc0's Competitive Advantage)

Features that separate gvc0 from every comparator in 2026. These align with Core Value.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Live-steerable feature DAG** | User watches the plan as it executes and can re-plan or edit any time — no "fire and forget" opacity, no "chat with one agent" narrow channel | HIGH | Feature-DAG graph with live states (REQ-TUI-01); manual edits always win (REQ-PLAN-05) |
| **Two-level planner (top-level features + feature-level tasks)** | Strategic vs tactical separation — planner prompts get less tangled, plans stay legible at scale | MEDIUM | REQ-PLAN-01/02; edit-collision rule (REQ-PLAN-07) resolves interaction |
| **Parallel feature & task execution** | Most comparators run one task at a time; gvc0 fans out limited only by worker cap — cycle time for a multi-feature prompt is ~max(feature) not sum | HIGH | Worker pool + DAG scheduler already designed; proven critical path metrics |
| **Merge train with "main never red" invariant** | User can launch many features without fear of breaking the tree; rebased+verified integration order is managed by the system | HIGH | REQ-MERGE-01/02; re-entry cap (REQ-MERGE-03) prevents silent failure |
| **Unified inbox** | All "things waiting on you" (agent asks, conflicts, approvals, auth expiry, orphan cleanup, re-entry parkings) in one place — never hunt across surfaces | MEDIUM | REQ-TUI-02; broadens standard "ask user" into a full attention layer |
| **Two-tier pause-resume** | Short waits keep the worker hot; AFK waits checkpoint and release the process — no memory bloat from parked tasks | HIGH | REQ-INBOX-02/03; spike target for pi-sdk replay fidelity |
| **Multi-task single-answer unblock** | One user response can unblock many tasks asking the same question — saves a power user from clicking through 10 duplicates | MEDIUM | REQ-INBOX-04; requires question-equivalence concept in inbox |
| **Agent-review verification before merge** | More flexible than "run tests" — can critique architecture, spot regressions tests miss, and comment inline | MEDIUM-HIGH | REQ-MERGE-04; pi-sdk agent performs the review; docs must say "verify = agent review" explicitly |
| **Planner prompt audit log** | User intent persists per-feature without a "goal" state machine — debuggable, teachable, never stale | LOW | REQ-PLAN-06 |
| **Config editable in TUI** | Power users touching model / cap / pause timeout shouldn't need JSON editing; the TUI already has focus | MEDIUM | REQ-TUI-04 |
| **Milestones as persistent feature groupings that steer but do not gate** | Priority-changeable without DAG edge churn; supports parallel workstreams | LOW-MEDIUM | Already part of `docs/architecture/graph-operations.md` |
| **Seamless crash auto-resume** | Orchestrator restart rehydrates live state instead of forcing triage | HIGH | REQ-STATE-02; higher bar than comparator norms |

### Anti-Features (Commonly Requested, Explicitly NOT Built)

These conflict with the thesis or erode the Core Value.

| Feature | Why Requested | Why Problematic for gvc0 | Alternative |
|---------|---------------|--------------------------|-------------|
| IDE sidebar / editor integration (VS Code panel, JetBrains plugin) | "Meet users where they code" | gvc0 is a TUI orchestrator, not an IDE companion; every IDE integration doubles surface area and dilutes the DAG-as-execution-model thesis | Run gvc0 in a terminal pane next to the IDE; the product is the TUI |
| Multi-user collaboration (shared DAG, team inbox) | Modern SaaS expectation | Single-user local-first is an explicit constraint; shared state implies a server, auth, permissions — all scope explosions | Users share the *repo*; gvc0 is personal to each user |
| Cloud-hosted execution | "Run my agents while laptop is closed" | Requires secrets in the cloud, sandboxing, billing, auth, multi-tenant infra | Source-install + local execution only in v1 |
| Plugin / extension marketplace | "Extend the planner / workers" | API surface commitment; v1 has no users to extend for | Encourage forks while API is fluid |
| "AI-generated commits" (autocompose beyond task output) | "Tidy up my commits" | Commits in gvc0 are created by tasks as their atomic output — post-hoc AI editing adds opacity and history churn | Task = commit; if the task's output is wrong, fix the task, not the commit |
| Natural-language diff review panel | "Let me ask about the diff" | The per-task transcript already shows what the agent did; a second "review with AI" surface fragments attention | Per-task transcript + verify agent — use those |
| Real-time everyone-sees-everything dashboards | Enterprise reflex | Single user + TUI = there is no "everyone" | N/A |
| Generic workflow DSL (write your own DAG YAML) | Power user customization | Planner is the DSL; YAML dilutes the "type a prompt" thesis | Manual graph editing in the TUI (REQ-TUI-03) |
| Rich HTML/web UI | "TUIs are old" | Conflicts with pi-tui direction; adds Electron / web-server stack; splits the product's center of gravity | Invest in making the TUI excellent instead |
| Per-task model autoselection | "Haiku for easy, Opus for hard" | Adds a heuristic that's wrong often enough to lose trust; hidden-complexity tax | Single global config per-role (REQ-CONFIG-01) |
| Persistent "goal" entity with its own UI | "Group work by goal" | Conflicts with user's decision — goal is ephemeral, milestones are the persistent grouping | Milestones + per-feature prompt audit log |

## Feature Dependencies

```
[Prompt entry] ─── top-level planner ──> [Feature DAG]
[Feature DAG] ─── feature-level planner ──> [Task DAG per feature]
[Task DAG]  ───> [Worker pool (pi-sdk Agents in worktrees)] ───> [Feature branch commits]
[Feature branch commits] ───> [Merge train] ───> [main]

[Inbox] ←──── agent await_response / request_help (from any worker)
[Inbox] ←──── merge-train re-entry cap hit
[Inbox] ←──── conflict detection (reservation or runtime overlap)
[Inbox] ←──── destructive-action approval request
[Inbox] ←──── auth expiry / missing credential
[Inbox] ←──── orphan-worktree triage after crash recovery

[Manual DAG edit] ─── overrides ──> [Planner output]
[Planner re-invocation] ─── additive only ──> [Feature DAG]

[Config TUI menu] ─── writes ──> [config.json] ─── watched ──> [Runtime]

[Seamless crash resume] ─── depends on ──> [SQLite durable state]
                                      ├──> [Worktree on disk]
                                      └──> [Transcript replay]

[Two-tier pause] ─── pi-sdk replay fidelity ──> SPIKE
```

### Dependency Notes

- **Top-level planner requires prompt entry and milestone (implicit or user-created).** A milestone must exist for features to attach; system can create a default "active" milestone on first run.
- **Feature-level planner requires a feature in the right work-control state.** It operates on features, producing tasks.
- **Worker pool requires worktree provisioning.** A task cannot start until its feature branch + per-task worktree are ready.
- **Merge train depends on feature branches being green.** `verify` phase (agent review) gates merge-queue entry.
- **Inbox unifies multiple attention sources** (agent asks, conflicts, approvals, auth, orphans, re-entry-cap parkings) — one surface replacing what would otherwise be 4+.
- **Seamless crash resume requires all three** of durable SQLite state, preserved worktrees, and transcript replay. Any one missing breaks the UX promise.
- **Two-tier pause depends on pi-sdk replay fidelity** — this is the primary spike target in STACK.md.
- **Manual edit vs. planner conflict is resolved by user-always-wins rule** — planner treats edits as constraints on re-invocation.

## MVP Definition

### Launch With (v1)

Minimum viable product that delivers the Core Value loop. If any is missing, the "prompt → live DAG → green `main`" story breaks.

- [ ] **Prompt entry + top-level planner** — can type a prompt and get a feature DAG
- [ ] **Feature-level planner** — feature expands into a task DAG when ready to execute
- [ ] **Worker pool** — parallel task execution in worktrees with pi-sdk Agents
- [ ] **Feature branches + task worktrees** — each task produces one squash-merge commit
- [ ] **Merge train** — serialized integration to `main` with rebase+verify
- [ ] **Agent-review verification** — verify phase actually runs a pi-sdk agent review before merge (not a stub)
- [ ] **Unified inbox** — agent asks, approvals, conflicts, auth issues, orphan cleanup, re-entry parkings all land here
- [ ] **Two-tier pause-resume** — short waits keep process; long waits checkpoint & release
- [ ] **Cancel (three levers)** — cancel-task-preserve, cancel-task-clean, cancel-feature-abandon
- [ ] **Re-plan (additive only)** — user can re-invoke planner mid-run; never touches live or done work
- [ ] **Manual DAG edit (user always wins)** — TUI-driven create/edit/split/merge/cancel/reorder
- [ ] **TUI with 4 primary surfaces** — feature DAG, inbox, merge-train, per-task transcript
- [ ] **Config editable in TUI** — no hand-editing JSON for the common config
- [ ] **Seamless crash auto-resume** — restart recovers live state without user triage
- [ ] **Retry transient / inbox semantic** — auto-recover from blips, ask for decisions on real failures
- [ ] **Per-feature planner prompt audit log** — captures user intent persistently
- [ ] **Global worker-count cap** — configurable, sane default
- [ ] **Single per-role model config** — top-planner / feature-planner / task-worker / verifier
- [ ] **Clarity docs** — execution flow, state shape, coordination semantics documented

### Add After Validation (v1.x)

Features to add once the core MVP loop is demonstrably working.

- [ ] Usage / cost display in TUI (tracking exists; enforcement deferred) — trigger: users ask for visibility
- [ ] Rich inbox filters (by feature, by severity) — trigger: inbox backlog makes triage slow
- [ ] Keyboard-only navigation polish — trigger: power users request muscle-memory shortcuts
- [ ] More sophisticated verify agent prompts (configurable review criteria) — trigger: verify misses regressions or nags too much
- [ ] Saved planner "styles" (e.g., preferred decomposition granularity) — trigger: users tune planner prompts repeatedly
- [ ] Feature summaries displayed as a timeline view — trigger: users want a "what happened" retrospective surface

### Future Consideration (v2+)

Deferred until v1 validates the core thesis. Many are already catalogued under `docs/feature-candidates/`.

- [ ] In-flight feature split/merge (`docs/feature-candidates/in-flight-split-merge.md`)
- [ ] Arbitrary persistent manual merge-train ordering (`docs/feature-candidates/arbitrary-merge-train-manual-ordering.md`)
- [ ] Distributed runtime (multi-machine) (`docs/feature-candidates/distributed-runtime.md`)
- [ ] Centralized conversation persistence (`docs/feature-candidates/centralized-conversation-persistence.md`)
- [ ] Advanced IPC guarantees (`docs/feature-candidates/advanced-ipc-guarantees.md`)
- [ ] Extended repair profiles (`docs/feature-candidates/extended-repair-profiles.md`)
- [ ] Git-tracked markdown state exports (`docs/feature-candidates/git-tracked-markdown-state-exports.md`)
- [ ] Graceful integration cancellation (`docs/feature-candidates/graceful-integration-cancellation.md`)
- [ ] Long verification timeouts (`docs/feature-candidates/long-verification-timeouts.md`)
- [ ] Per-task cross-feature suspension (`docs/feature-candidates/per-task-cross-feature-suspension.md`)
- [ ] Phase timeouts (`docs/feature-candidates/phase-timeouts.md`)
- [ ] Proposal editing and toggling (`docs/feature-candidates/proposal-editing-and-toggling.md`)
- [ ] Soft cancel (`docs/feature-candidates/soft-cancel.md`)
- [ ] Structured feature-phase outputs (`docs/feature-candidates/structured-feature-phase-outputs.md`)
- [ ] Worker scheduling policies (`docs/feature-candidates/worker-scheduling-policies.md`)
- [ ] Claude Code harness (`docs/feature-candidates/claude-code-harness.md`)
- [ ] Merge-train niceness / fairness (`docs/feature-candidates/merge-train-niceness.md`)
- [ ] Runtime ID validation (`docs/feature-candidates/runtime-id-validation.md`)
- [ ] Graph dependency overload typing (`docs/feature-candidates/graph-dependency-overload-typing.md`)
- [ ] Budget *enforcement* behavior (tracking enabled in v1; enforcement policy deferred)
- [ ] Per-task / per-feature model override
- [ ] Multi-repo / cross-repo orchestration
- [ ] Standalone-binary distribution (SEA / esbuild bundle)
- [ ] Rich inbox question de-duplication / multi-task auto-unblock UX

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Prompt entry + top-level planner | HIGH | MEDIUM | P1 |
| Feature-level planner | HIGH | MEDIUM | P1 |
| Worker pool + pi-sdk Agent processes | HIGH | HIGH | P1 |
| Feature branches + task worktrees | HIGH | MEDIUM | P1 |
| Merge train (rebase + verify) | HIGH | HIGH | P1 |
| Agent-review verification | HIGH | MEDIUM | P1 |
| Unified inbox | HIGH | MEDIUM | P1 |
| Two-tier pause-resume | HIGH | HIGH | P1 (spike-gated) |
| Cancel (three levers) | HIGH | MEDIUM | P1 |
| Re-plan (additive) | HIGH | LOW | P1 |
| Manual DAG edit | HIGH | MEDIUM | P1 |
| 4-surface TUI | HIGH | HIGH | P1 |
| Config editable in TUI | MEDIUM | MEDIUM | P1 |
| Seamless crash auto-resume | HIGH | HIGH | P1 |
| Retry-transient / inbox-semantic | MEDIUM | LOW | P1 |
| Per-feature planner audit log | MEDIUM | LOW | P1 |
| Global worker cap | MEDIUM | LOW | P1 |
| Per-role model config | MEDIUM | LOW | P1 |
| Clarity docs (flow, state, coordination) | HIGH | MEDIUM | P1 |
| Usage/cost display | MEDIUM | LOW | P2 |
| Rich inbox filters | MEDIUM | LOW | P2 |
| Keyboard nav polish | LOW | LOW | P2 |
| Verify prompt configurability | MEDIUM | LOW | P2 |
| Planner style presets | LOW | LOW | P3 |
| Feature summary timeline | LOW | MEDIUM | P3 |
| In-flight split/merge | MEDIUM | HIGH | P3 |
| Distributed runtime | LOW | HIGH | P3 |
| Multi-repo support | MEDIUM | HIGH | P3 |
| Standalone binary | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for v1 — no core loop without it
- P2: v1.x — add when users prove the need
- P3: v2+ — past product-market fit

## Competitor Feature Analysis

| Feature | Claude Code | Codex CLI / Cursor Agent | Aider (branch mode) | OpenHands / SWE-agent | Devin | GSD-2 (lineage) | gvc0 approach |
|---------|-------------|--------------------------|---------------------|----------------------|-------|-----------------|---------------|
| Entry surface | Interactive CLI + slash commands | IDE / CLI chat | CLI | Web / CLI | Web/SaaS | CLI / slash commands | TUI + prompt |
| Decomposition | Implicit (single agent per turn) | Implicit | Implicit | Sub-agents (ad hoc) | Hidden | Phases (sequential by default) | **Two-level DAG (features + tasks)** |
| Concurrency | Parallel-tool / sub-agent | Single | Single | Limited parallel | Hidden | Sequential default | **Parallel features and tasks** |
| Integration | Commits + PRs via gh | Commits | Commits per session | Commits | PR | PRs | **Merge train to `main`** |
| Human-in-the-loop | Approvals + chat + ExitPlanMode | Chat / approval | Prompt-driven | Ad hoc | Chat | Slash-command gated | **Unified inbox** |
| Resume/recovery | Session resume; manual | Limited | Per-session | Per-session | Opaque | Phase artifacts on disk | **Seamless auto-resume** |
| Budget visibility | Usage shown | Usage shown | Costs tracked | Varies | Hidden | Rough estimates | **Pi-sdk usage + TUI surface (v1.x enforce)** |
| TUI / UI | CLI | IDE / CLI | CLI | Web | Web | CLI + markdown artifacts | **Multi-surface TUI (pi-tui)** |
| Main-branch safety | User's responsibility | User's responsibility | User's responsibility | User's responsibility | Sandboxed | User's responsibility | **Merge train + "main never red" invariant** |
| Planner re-invocation | Restart chat | Restart chat | Restart | Restart | Opaque | Replan command | **Additive re-plan; user picks session vs fresh** |

**Synthesis:** gvc0 sits uniquely at the intersection of *DAG decomposition + parallel execution + live-steerable + merge-train-safe + unified-inbox*. No current comparator hits all five. The differentiation is defensible; the risk is executional complexity, not strategic overlap.

## Sources

- `/home/alpine/vcode0/.planning/PROJECT.md` — scope, decisions, core value
- `/home/alpine/vcode0/ARCHITECTURE.md` — design thesis and component map
- `/home/alpine/vcode0/docs/compare/gsd-2.md` — lineage and sequential→DAG shift
- `/home/alpine/vcode0/docs/compare/wave.md` — additional comparator notes
- `/home/alpine/vcode0/docs/feature-candidates/*` — already-deferred work catalog (informs v2+ list)
- General ecosystem knowledge of Claude Code, Codex, Cursor Agent, Aider, OpenHands, SWE-agent, Devin (pre-2026 cutoff; verify specifics before strategic bets)

---
*Feature research for: DAG-first autonomous coding orchestrator*
*Researched: 2026-04-23*
