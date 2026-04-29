# Landscape Overview — gvc0 vs. the 2026 AI-coding ecosystem

Snapshot taken on 2026-04-28 from web-verified public materials only. This is a high-level survey across ~19 products and frameworks, scored against gvc0's distinguishing architectural axes. Per-product deep dives live in sibling pages where the comparison justifies one. Worth revisiting periodically as the field is moving fast.

## Why this page exists

The AI-coding-agent space changed a lot between mid-2025 and 2026-04. Process-per-task workers in git worktrees became commodity. HITL plan-approval became commodity. Multi-model routing and long-running cloud sandboxes became commodity. The question this page tries to answer honestly: **of gvc0's distinguishing properties, which ones still differentiate it, and which have been matched in public products?**

Per-page deep dives in this directory cover the three products where the comparison goes deeper than a row in a table:

- [overstory.md]](../competitors/overstory.md) — closest architectural analogue (FIFO merge queue + 4-tier conflict resolution).
- [factory-ai.md]](../competitors/factory-ai.md) — closest enterprise/commercial competitor (coordinator + specialized droids).
- [langgraph.md]](../alternatives/langgraph.md) — only realistic migration-substrate candidate per the frameworks survey.

Other deep dives in this directory: [gsd-2.md]](../lineage/gsd-2.md) (direct lineage), [wave.md]](../alternatives/wave.md) (pipeline-engine alternative).

## The 11 axes scored

These are the properties that distinguish gvc0 architecturally. Each is a column in the comparison table.

1. **DAG** — long-lived authoritative DAG-as-project-state (milestone → feature → task; feature-only-on-feature, task-only-within-feature).
2. **PPT** — process-per-task workers in git worktrees + NDJSON-over-stdio IPC.
3. **MT** — programmatic merge train into `main` (rebase → post-rebase CI → main-SHA validation → `merge --no-ff`).
4. **PA** — proposal-graph planner with human approval before authoritative graph mutation.
5. **RP** — replanner agent for verify-failure recovery.
6. **SS** — split state model (work_control / collaboration_control / run-state).
7. **VI** — typed `VerifyIssue[]` payload with sources `verify | ci_check | rebase`.
8. **CC** — conflict coordination (same-feature write-path locks + cross-feature primary/secondary).
9. **CR** — crash recovery via persistence + git refs authoritative.
10. **BR** — budget governance + tiered model routing (heavy/standard/light).
11. **TUI** — terminal UI as primary interface.

Legend: **Y** = direct equivalent; **~** = partial / approximate; **·** = absent or not publicly described.

The "not publicly described" caveat matters — many commercial products may have internal state machines we cannot inspect; absence in this table reflects what is documented or surfaced, not necessarily what exists.

## Comparison table

| Product (status) | DAG | PPT | MT | PA | RP | SS | VI | CC | CR | BR | TUI |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **gvc0** (this repo) | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| **GSD-2** (lineage; OSS) | Y | Y | ~ | Y | ~ | ~ | ~ | ~ | Y | ~ | Y |
| **Devin 3.0** (commercial) | ~ | Y | · | ~ | Y | · | · | · | Y | · | · |
| **OpenHands v1.6** (OSS) | ~ | Y | · | ~ | ~ | · | · | · | ~ | · | · |
| **Factory.ai Droids** (commercial) | ~ | Y | ~ | ~ | ~ | · | · | ~ | Y | Y | · |
| **Overstory** (OSS) | · | Y | **Y** | ~ | · | ~ | · | **Y** | Y | · | · |
| **Cursor 3** (commercial) | · | Y | · | ~ | ~ | · | · | · | Y | Y | · |
| **Claude Code** (commercial) | · | Y | · | Y | · | · | · | · | · | ~ | Y |
| **Codex CLI** (OSS+commercial) | · | ~ | · | ~ | · | · | ~ | · | ~ | ~ | Y |
| **Sourcegraph Amp** (commercial) | · | ~ | · | ~ | · | · | · | · | ~ | · | · |
| **Conductor** (commercial) | · | Y | · | ~ | · | · | · | · | ~ | · | · |
| **Claude Squad** (OSS) | · | Y | · | ~ | · | · | · | · | · | · | Y |
| **claude-flow / Ruflo v3.5** (OSS) | ~ | Y | · | ~ | ~ | · | · | · | ~ | ~ | · |
| **Composio agent-orchestrator** (OSS) | · | Y | ~ | ~ | Y | · | ~ | ~ | · | · | · |
| **Plandex** (OSS) | ~ | ~ | · | Y | ~ | · | · | · | ~ | · | Y |
| **Cline / Roo Code** (OSS) | · | · | · | Y | · | · | · | · | · | · | · |
| **Aider** (OSS) | · | · | · | · | · | · | · | · | · | · | ~ |
| **LangGraph** (OSS framework) | Y | · | · | Y | Y | · | · | · | Y | · | · |
| **Tessl** (commercial) | · | ~ | · | ~ | · | · | · | · | · | · | · |

Long-tail products surveyed but not tabulated (none change the shape of the conclusions): Goose 1.20.1, Continue.dev, Replit Agent 3, Bolt.new, v0.app, Junie CLI, Jules, Project Jitro, Anthropic Managed Agents, Vibe Kanban, Sketch / Shelley, Antfarm + OpenClaw, agent-deck, Antigravity, Worktrunk, agent-worktree.

## What's commodity vs. what's unique

### Commodity by 2026 — no longer a moat

- **PPT (process-per-task in worktrees).** Now table stakes. Cursor 3 Parallel Agents, Conductor, Claude Squad, Vibe Kanban, claude-flow, Composio, Sketch, Overstory, Factory.ai, OpenHands all do this. The `git worktree` + isolated child process pattern is the default integration for parallel agents.
- **PA (HITL plan approval).** Exists in some form across Plandex (review-and-apply), Claude Code (plan mode), Devin 3.0 (dynamic re-planning surfacing to user), Copilot Workspace (plan/brainstorm/repair), Cline (per-step approval gates), LangGraph (interrupts). None implement it as a *separate proposal-graph data structure with explicit accept/reject* the way gvc0 does, but the user-facing pattern is widespread.
- **CR (crash recovery / session persistence).** Standard in cloud-hosted agents (Devin, Cursor cloud, Factory, Anthropic Managed Agents) and present in several local ones (Overstory's SQLite, LangGraph checkpointing).
- **TUI** + **BR (budget routing).** Terminal-first UIs (Claude Code, Codex CLI, Plandex, Junie CLI, Claude Squad) and multi-model picker / routing (Cursor's model picker, Codex CLI, claude-flow) are widespread.

### Rare — only one or two close matches

- **MT (programmatic merge train into main).** Only **Overstory** implements this as a core orchestration primitive: FIFO SQLite-backed queue + 4-tier conflict resolution. **Composio agent-orchestrator** does notification-style PR-merge gating ("PRs approved with green CI trigger notifications to merge"), but that's a notification pattern, not a programmatic rebase → post-rebase-CI → main-SHA-validation → `merge --no-ff` train. Everyone else punts to GitHub Merge Queue / Mergify / Graphite, which are general-purpose CI tools, not AI-orchestrator features.
- **CC (cross-feature coordination with primary/secondary).** Overstory has 4-tier conflict resolution but doesn't publicly formalize a primary/secondary policy across long-lived feature branches. No other product publicly describes anything like this.

### Genuinely unique to gvc0 / GSD-2 lineage

- **DAG (long-lived authoritative DAG-as-project-state with feature-only-on-feature + task-only-within-feature constraints).** LangGraph and agent-deck use DAGs for execution flow. Most other coding agents treat plans as ephemeral per-run artifacts. Only **GSD-2** (gvc0's direct ancestor) and **Factory.ai's** coordinator approach come architecturally close — and neither publicly formalizes the dependency-shape constraints that gvc0 enforces.
- **SS (split state model: work_control / collaboration_control / run-state).** No surveyed product publicly separates execution-phase tracking from branch/merge coordination from transient run details. Most products either collapse these into a single status enum or hide the model entirely.
- **VI (typed `VerifyIssue` payload with sourced classification).** Codex Security (Mar 2026) classifies issues by severity but doesn't expose a discriminated-source schema. Composio's CI-failure auto-fix is the closest functional match, but the issue payload is not typed. Everyone else returns free-form text and relies on the agent's own re-parsing.
- **RP (dedicated replanner agent on verify failure).** Devin 3.0 has dynamic re-planning (single-agent mid-loop), Composio auto-fixes CI failures (single tool), but no surveyed product has a *separate* replanner agent with its own toolset whose only job is recovery routing on verify/CI/rebase failure. LangGraph supports compile-time replanning patterns but doesn't ship a recovery agent.

## Follow-up recommendations

### Read first, in order of payoff

1. **Overstory** ([github.com/jayminwest/overstory](https://github.com/jayminwest/overstory)). Single closest architectural analogue. Read the source for: FIFO queue semantics, 4-tier conflict-resolution rules, how SQLite stays consistent with git refs. See [overstory.md]](../competitors/overstory.md) for the deep dive. If their primary/secondary semantics differ from gvc0's, that's a gap worth documenting; if they overlap, gvc0 should cite Overstory as prior art in `docs/operations/conflict-coordination.md`.
2. **Factory.ai Droids** ([factory.ai](https://factory.ai/)). Closest commercial competitor with coordinator-plus-specialists shape; Series C $150M (Apr 2026). See [factory-ai.md]](../competitors/factory-ai.md) for the deep dive. Worth tracking for: how they avoid (or implicitly enforce) feature/task dependency constraints, and whether a public spec of their integration train ever surfaces.
3. **GSD-2 lineage check** ([github.com/gsd-build/gsd-2](https://github.com/gsd-build/gsd-2)). [gsd-2.md]](../lineage/gsd-2.md) already exists; worth periodic re-reading because gvc0 is a TypeScript remake and the boundary between inherited and original architecture matters for credit and for understanding intent.

### Evaluate as potential migration substrate

4. **LangGraph** ([github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)) is the only realistic candidate per the frameworks survey: it has a real DAG-as-state, real interrupts, real checkpointing. See [langgraph.md]](../alternatives/langgraph.md) for the evaluation. Headline finding: adopting it would mean replacing the scheduler core but not the merge train, and would cost the orchestrator/core boundary discipline. Probably not worth a migration; possibly worth borrowing the interrupt-and-resume protocol pattern.

### Sharpen the moat

5. **Document the unique axes explicitly in `ARCHITECTURE.md`.** The split state model, the typed `VerifyIssue` discriminated union, the cross-feature primary/secondary policy, and the feature-only-on-feature / task-only-within-feature DAG constraints aren't surfaced as architectural distinctives in the top-level architecture doc — they read as implementation choices. If gvc0 ever needs to position vs. Devin / Factory / Overstory, those four properties are the differentiators worth naming.
6. **Promote programmatic merge train to a dedicated topic page.** Today the rebase → post-rebase-CI → main-SHA-validation → `merge --no-ff` invariant chain is documented inline in operations docs. A dedicated `docs/architecture/merge-train.md` with the invariant chain and recovery semantics spelled out would punch above its weight, given that this is gvc0's strongest moat.

### Watch for displacement

7. **Anthropic Claude Managed Agents** (launched 2026-04-10) and **Project Jitro** (Google, expected at I/O on 2026-05-19) are the two pieces that could change the platform layer underneath gvc0. If Anthropic's managed orchestration ships graph-state, sandboxing, and merge-coordination as first-party primitives, gvc0's ports/adapters approach lets it absorb them — but the orchestrator surface area would shrink. Worth a re-scan in late May 2026.

## Public references

### Autonomous coding agents

- [Cognition / Devin](https://cognition.ai/) — [Devin 3.0 release notes](https://docs.devin.ai/release-notes/2026)
- [OpenHands](https://openhands.dev/) — [OpenHands GitHub](https://github.com/OpenHands/OpenHands)
- [Cursor (vs Claude Code, Apr 2026)](https://fordelstudios.com/research/cursor-vs-claude-code-april-2026-what-changed)
- [JetBrains Junie CLI beta](https://blog.jetbrains.com/junie/2026/03/junie-cli-the-llm-agnostic-coding-agent-is-now-in-beta/)
- [OpenAI Codex CLI](https://github.com/openai/codex) — [Codex changelog](https://developers.openai.com/codex/changelog)
- [Sourcegraph Amp spinout (2026)](https://tessl.io/blog/sourcegraph-spins-out-ai-coding-agent-amp-as-a-standalone-company/)
- [Replit Agent 3 / v0.app rebrand context](https://medium.com/@aftab001x/the-2026-ai-coding-platform-wars-replit-vs-windsurf-vs-bolt-new-f908b9f76325)
- [Continue.dev](https://www.continue.dev/)

### Parallel-worktree / sandboxed coding agents

- [Conductor (conductor.build)](https://docs.conductor.build/)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)
- [Claude Squad review](https://vibecodinghub.org/tools/claude-squad)
- [Sketch.dev / Shelley](https://sketch.dev/) — [Sketch GitHub](https://github.com/boldsoftware/sketch)
- [claude-flow / Ruflo](https://github.com/ruvnet/ruflo)
- [Overstory](https://github.com/jayminwest/overstory)
- [Composio agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [Antfarm](https://github.com/snarktank/antfarm)
- [Antigravity (Google)](https://stormap.ai/post/google-ai-studio-antigravity-integration-2026)

### Frameworks and patterns

- [LangGraph](https://github.com/langchain-ai/langgraph)
- [agent-deck (DAG decomposition)](https://github.com/claude-world/agent-deck)
- [Code Agent Orchestra (Addy Osmani)](https://addyosmani.com/blog/code-agent-orchestra/)
- [E2B / Daytona / Modal sandbox benchmark](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026)

### Enterprise / managed offerings

- [Factory.ai](https://factory.ai/) — [Factory $150M Series C (Apr 2026)](https://tech-insider.org/factory-ai-150-million-series-c-khosla-coding-droids-2026/)
- [Tessl](https://tessl.io/)
- [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) — [launch coverage](https://winbuzzer.com/2026/04/10/anthropic-launches-claude-managed-agents-enterprise-ai-xcxwbn/)
- [Google Jules](https://jules.google) — [Project Jitro (Jules successor)](https://www.testingcatalog.com/google-prepares-jules-v2-agent-capable-of-taking-bigger-tasks/)

### gvc0 lineage

- [GSD-2](https://github.com/gsd-build/gsd-2)
- [pi-mono (Mario Zechner)](https://github.com/badlogic/pi-mono)
- [Mario Zechner pi-coding-agent post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [Armin Ronacher on Pi / OpenClaw (2026-01-31)](https://lucumr.pocoo.org/2026/1/31/pi/)

## Revisit notes

This survey is worth revisiting:

- After **Project Jitro** ships at I/O 2026-05-19 (will likely change Google's posture in this space).
- If **Anthropic Managed Agents** ships graph-state / merge-coordination primitives.
- If **Overstory** publishes a primary/secondary cross-feature policy, or **Factory.ai** publishes their coordinator's integration semantics.
- Whenever a new product publicly claims a programmatic merge train into main as a core orchestration primitive — that's the closest thing to a direct architectural competitor today.

## Adoption status

Tracks which recommendations from this overview have landed in gvc0. Update when status changes; reference the commit so reviewers can audit scope.

Statuses: `done` (fully applied) · `partial` (subset applied; note scope) · `open` (not yet started) · `deferred` (intentionally postponed) · `rejected` (decided against; note reason).

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| R1 — Read Overstory source (FIFO semantics, 4-tier conflict, SQLite/git consistency); cite as prior art in `docs/operations/conflict-coordination.md` if semantics overlap | open | — | Deep dive exists at [overstory.md]](../competitors/overstory.md); citation in conflict-coordination.md not yet added. |
| R2 — Track Factory.ai Droids for feature/task dependency constraints and integration-train spec | open | — | Deep dive at [factory-ai.md]](../competitors/factory-ai.md); no coordinator spec has surfaced publicly. |
| R3 — Periodic GSD-2 lineage re-read to maintain clarity on inherited vs. original architecture | open | — | [gsd-2.md]](../lineage/gsd-2.md) exists; no dated re-read recorded. |
| R4 — Evaluate LangGraph as migration substrate; consider borrowing interrupt-and-resume protocol pattern | open | — | Evaluation at [langgraph.md]](../alternatives/langgraph.md); headline: migration not worth it, pattern borrow unrecorded. |
| R5 — Document the four unique axes (split state model, typed `VerifyIssue`, cross-feature primary/secondary, feature/task DAG constraints) explicitly in `ARCHITECTURE.md` as competitive differentiators | partial | — | `ARCHITECTURE.md` names the split-state model and DAG constraints in Core Thesis, but does not position them as differentiators or reference the competitive landscape. The typed `VerifyIssue` and cross-feature primary/secondary axes are not named there at all. |
| R6 — Promote programmatic merge train to a dedicated `docs/architecture/merge-train.md` topic page with invariant chain and recovery semantics | open | — | No `docs/architecture/merge-train.md` exists; invariants are documented inline in operations docs. |
| R7 — Watch Anthropic Managed Agents and Project Jitro for platform-layer changes that could affect gvc0's scope | open | — | Watching brief; Project Jitro expected at I/O 2026-05-19. |
