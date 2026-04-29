# AGENTS.md and the Agentic AI Foundation

Snapshot taken on 2026-04-29. State of cross-vendor convention layers for autonomous coding agents, focused on AGENTS.md adoption and the Linux Foundation Agentic AI Foundation (AAIF).

## Why this page matters

By 2026-04, "instructions to coding agents in this repo" has converged on a cross-vendor convention. gvc0 currently respects only `CLAUDE.md`. This page documents the convergence and the implications for gvc0's interop posture.

## AAIF in one paragraph

The Linux Foundation Agentic AI Foundation was founded December 2025 by Anthropic, Block, and OpenAI. It now stewards the **Model Context Protocol (MCP)**, the **AGENTS.md** convention, and Block's **goose** agent runtime. Membership has expanded to include GitHub, Cursor, Sourcegraph, and several enterprise consumers. AAIF is the closest thing the agent ecosystem has to a neutral standards body.

## AGENTS.md adoption snapshot

By 2026-04, the following products read `AGENTS.md` (in addition to whatever proprietary file they support):

| Product | Reads AGENTS.md | Reads vendor-specific file |
|---|---|---|
| GitHub Copilot Workspace | Yes | `.github/copilot-instructions.md` |
| Cursor | Yes | `.cursorrules` |
| Sourcegraph Cody | Yes | `.sourcegraph/cody-instructions.md` |
| Aider | Yes | `CONVENTIONS.md` |
| Claude Code | Yes (April 2026 update) | `CLAUDE.md` |
| Devin | Yes | `.devin/instructions.md` |
| Codex CLI | Yes | `.codex/instructions.md` |
| Goose | Yes (canonical) | n/a |
| OpenHands | Yes | `.openhands/instructions.md` |

The pattern is "read AGENTS.md as the cross-vendor baseline, plus the vendor-specific file as override." File precedence is typically vendor-specific > AGENTS.md > nothing.

## What AGENTS.md is and is not

**Is**: a markdown file at the repo root (or `.agents/AGENTS.md`) containing project-level instructions. Common sections: build commands, test commands, code style, architectural conventions, what not to do. Free-form markdown — no schema, no validation.

**Is not**: a tool-execution contract, a permission model, a workflow specification, or a state-machine description. AGENTS.md is purely natural-language guidance to the agent.

The convention is that AGENTS.md is the *minimum* an agent should respect. Vendor-specific files extend or override.

## Why this matters for gvc0

gvc0's `CLAUDE.md` is the project-instruction file. It works because gvc0's baseline harness is pi-sdk (which has no convention) and the deferred `ClaudeCodeHarness` reads `CLAUDE.md` natively (per [claude-code-harness.md](../../feature-candidates/runtime/claude-code-harness.md)).

The gap: when a user opens this repo in *any other* agent (Cursor, Codex, Aider, Goose), they see no instructions. The repo looks unannotated to non-Claude-Code agents.

The fix is small: write an `AGENTS.md` that mirrors the substantive content of `CLAUDE.md`, and have the gvc0 worker context assembly read `AGENTS.md` first, then `CLAUDE.md` as override. See [agents-md-interop.md](../../feature-candidates/interop/agents-md-interop.md).

## Why this is interop, not lock-in

Reading AGENTS.md does not commit gvc0 to anything. The file is plain markdown — no protocol, no tooling dependency. The only cost is duplication if both files exist; the only design decision is precedence (gvc0 should treat the more specific file as override, matching the cross-vendor convention).

## What AAIF is plausibly going to standardize next

AAIF's roadmap (per public materials) includes:

- **MCP transport hardening**: standardized stdio + HTTP transports, server discovery, capability negotiation. Already touches gvc0 via the deferred Claude Code MCP server design.
- **Agent capability declaration**: a manifest format describing what an agent can/cannot do. Speculative; would touch gvc0's harness boundary.
- **Cross-vendor evaluation harness**: a shared benchmark methodology. Would affect gvc0's empirical positioning if it becomes the de facto comparator.

What AAIF is *not* proposing (as of 2026-04):

- A workflow / orchestration spec. The runtime layer remains vendor-specific.
- A state-machine spec for coordinator-class agents. gvc0's split-state model has no AAIF analogue.
- A merge-train or integration spec. Out of scope.

## Implications for gvc0's positioning

The convention layer (MCP, AGENTS.md) is converging fast. The runtime layer (orchestration, state machines, merge semantics) is not. gvc0's distinctive properties live entirely at the runtime layer, so AAIF stewardship does not erode the moat — it just commodifies the surfaces gvc0 was never trying to differentiate on.

The interop posture should be:

- **Adopt convention layers eagerly.** Read AGENTS.md, support MCP servers, respect any future cross-vendor file.
- **Keep runtime layers distinctive.** The DAG, the merge train, the typed verify model, the split state — these are not AAIF's job to standardize and shouldn't be.

## Public references

- AAIF founding: <https://www.linuxfoundation.org/press/announcing-the-agentic-ai-foundation>
- AGENTS.md spec / examples: <https://github.com/agents-md/spec>
- MCP spec (AAIF-stewarded): <https://modelcontextprotocol.io/>
- Goose: <https://block.github.io/goose/>

## Adoption status

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| Write `AGENTS.md` mirroring `CLAUDE.md` content for cross-vendor interop | deferred | — | See [agents-md-interop.md](../../feature-candidates/interop/agents-md-interop.md). |
| Wire `AGENTS.md` into worker context assembly (read first, `CLAUDE.md` as override) | deferred | — | See [agents-md-interop.md](../../feature-candidates/interop/agents-md-interop.md). Blocked on harness abstraction work. |
| Adopt convention layers (MCP, AGENTS.md) eagerly; keep runtime layers distinctive | partial | — | MCP support is tracked under the Claude Code harness candidate; AGENTS.md interop is deferred above. Runtime distinctiveness is preserved by design. |
| Monitor AAIF roadmap items (MCP transport hardening, agent capability declaration, cross-vendor eval harness) | open | — | Watch items; no implementation work until proposals stabilize. |

## Revisit notes

Worth revisiting after:

- AAIF publishes its first cross-vendor evaluation harness.
- An AGENTS.md schema or schema-fragment proposal emerges (would change the "free-form markdown" footing).
- A new vendor (likely Google or Microsoft DeepMind) joins AAIF — would shift the political balance.
- gvc0 ships AGENTS.md interop and we measure adoption signal.
