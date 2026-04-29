# Feature Candidate: AGENTS.md Interop

## Status

Future feature candidate. Surfaced from the [2026-04-29 deep-dive synthesis](../compare/2026-04-29-deep-dive-synthesis.md).

## Baseline

Today gvc0's worker context assembly reads `CLAUDE.md` (project-level) when present. There is no support for `AGENTS.md`, the cross-vendor convention now stewarded by the Linux Foundation Agentic AI Foundation (AAIF).

## Candidate

Read `AGENTS.md` alongside `CLAUDE.md` in the worker context assembly, with documented precedence.

Precedence rule:

1. Vendor-specific `CLAUDE.md` overrides generic `AGENTS.md`.
2. When both exist, both are loaded; the vendor-specific file is appended last so its content is the most-recent in the rendered prompt.
3. When only `AGENTS.md` exists, it stands alone.
4. When only `CLAUDE.md` exists, current behavior is unchanged.

This matches the cross-vendor convention used by GitHub, Cursor, Cody, Aider, Devin, Codex, and (since April 2026) Claude Code itself.

## Why It Matters

By 2026-04, AGENTS.md is the cross-vendor file most coding agents read for project-level instructions. The convention is free-form markdown — no protocol, no validation, no tooling dependency. Adoption is low-cost interop, not a commitment.

The gap today: a user who opens this repo in Cursor, Codex, Aider, Goose, or any other non-Claude-Code agent sees no project instructions. The repo looks unannotated. This affects:

- **Onboarding agents that aren't gvc0's worker harness.** A developer running `cursor` or `aider` on a gvc0-managed branch gets less context than if they were inside gvc0.
- **Future harness portability.** If gvc0 ships a non-pi-sdk harness (per [claude-code-harness.md](./claude-code-harness.md) or beyond), AGENTS.md is the format that just works.
- **Perception.** AAIF has the political weight of Anthropic + Block + OpenAI + GitHub + Cursor. Ignoring its conventions reads as parochial.

The cost is small: a file-loading branch in `src/runtime/context/` plus a render-order rule.

## How It Would Be Implemented

1. Add `AGENTS.md` to the file-discovery path in `src/runtime/context/index.ts` (or wherever `CLAUDE.md` is currently resolved). Same upward-walk semantics from the worktree.
2. Render order: `AGENTS.md` block first, `CLAUDE.md` block second. The downstream system prompt builder concatenates both, with the vendor-specific block appearing later so it acts as override.
3. New unit test: `test/unit/runtime/context.test.ts` exercises four cases — both files present, only AGENTS.md, only CLAUDE.md, neither.
4. Integration test: a worktree fixture with both files; assert worker prompt contains both blocks in the correct order.
5. Documentation: update `docs/reference/knowledge-files.md` (or equivalent) with the precedence rule and an example.
6. Optional: write a minimal `AGENTS.md` for gvc0's own repo, derived from `CLAUDE.md`, so the repo is self-annotated for non-Claude-Code agents. This is independent of the code change but a natural follow-up.

## Why Deferred

- Only the Claude Code harness is currently exercised; the broader interop value is realized by users running other agents on gvc0 worktrees, which is not the dominant use case today.
- Writing a clean `AGENTS.md` for gvc0's own repo requires a careful pass over `CLAUDE.md` to separate vendor-specific instructions from generic project instructions. Some content (e.g., `--bare`, `--allowedTools`) is Claude-Code-specific and shouldn't migrate.
- Settings-isolation for the worker harness already excludes user-level `~/.claude/CLAUDE.md`; the analogous policy for user-level `~/AGENTS.md` (if such a thing emerges) needs a similar exclusion path.

## When to Promote

Promote from candidate to baseline when:

- A second harness backend ships (AGENTS.md becomes the natural neutral format).
- The first non-Anthropic-family user reports running gvc0 on a repo where AGENTS.md is the only project-instruction file present.
- AAIF publishes a schema fragment (current AGENTS.md is free-form; if it becomes structured, the load + render path needs schema awareness).

## Public references

- AGENTS.md spec: <https://github.com/agents-md/spec>
- AAIF stewardship: <https://www.linuxfoundation.org/press/announcing-the-agentic-ai-foundation>
- Topic page: [agents-md-and-aaif.md](../compare/agents-md-and-aaif.md).

## Notes Carried Forward From Design Discussion

- Considered making AGENTS.md the primary file with CLAUDE.md as fallback; rejected. Backwards compatibility with existing gvc0 installs that have CLAUDE.md only requires CLAUDE.md to keep working unchanged.
- Considered loading AGENTS.md but warning if it conflicts with CLAUDE.md; rejected as noise. Two free-form markdown files cannot be reliably "conflict-detected." Render both; let the prompt absorb the duplication.
- Considered supporting `.agents/AGENTS.md` location variant from the spec; baseline is repo-root only, with `.agents/AGENTS.md` as a follow-on if anyone uses it in the wild.
