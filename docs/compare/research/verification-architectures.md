# Verification Architectures

Snapshot taken on 2026-04-29. How autonomous coding agents verify their own work, and what the empirical and standardization picture looks like in 2026.

## Why this page matters

Verification is one of gvc0's three remaining moats (alongside git-refs-authoritative state and the programmatic merge train). The typed `VerifyIssue` payload + dedicated replanner agent is unique among public products. This page documents what others do, what the evidence says about review correctness, and where SARIF fits as an interop surface.

## Two findings shape the design space

### Finding 1: Same-family LLMs share blind spots (arXiv 2604.19049)

The paper measures code-review agreement across model families. Same-family reviewers agree more often than disagree, even on cases the consensus turns out to be wrong. Cross-family review (planner from one family, reviewer from another) catches roughly 16% additional issues over same-family review.

The correlation strengthens with model capability. Stronger models within a family converge harder; cross-family disagreement is the signal that survives.

**Implication for gvc0**: pinning the replanner to a different model family than the planner is a small wiring change with measurable upside. See [cross-family-replanner.md](../../feature-candidates/coordination/cross-family-replanner.md).

### Finding 2: SWE-Bench Verified has test-design issues (OpenAI Feb 2026 audit)

OpenAI's February 2026 audit found 59.4% of SWE-Bench Verified problems had test-design issues — tests that pass on incorrect implementations, tests that fail on correct ones, or tests that depend on hidden environmental state. SWE-Bench Pro is the announced successor with stricter test design.

**Implication for gvc0**: any benchmark-driven claim about gvc0 quality should wait for SWE-Bench Pro. The current Verified scores are not a reliable comparator.

## How other agents verify

| Agent | Verification approach | Failure recovery |
|---|---|---|
| **gvc0** | Typed `VerifyIssue[]` from `verify | ci_check | rebase`; dedicated replanner agent | Replanner consumes typed issues, mutates graph |
| **Devin 3.0** | Generic "did the agent claim success?" + sandbox state inspection | Re-prompt loop, no typed issue model |
| **OpenHands v1.6** | Test-runner output piped back to agent | Agent re-prompts itself |
| **Cursor 3** | Lint + test runs in sandbox, surfaced to user | Human-mediated |
| **Claude Code** | Built-in test/lint tools, surfaced to user | Human-mediated |
| **Codex CLI** | Sandbox + test runner | Re-prompt |
| **Factory.ai** | "Verify droid" specialized agent | Coordinator handoff (state-machine not public) |
| **Overstory** | CI green/red gate before merge | Tier 3/4 conflict resolution rerun |
| **Composio orchestrator** | PR-level "approved with green CI" notification | Human-mediated |
| **LangGraph** | Whatever the graph defines | Whatever the graph defines |

The pattern: most products either (a) re-prompt the same agent with raw output, or (b) hand off to a human. Only Composio and gvc0 publicly formalize the verify-success-gates-merge invariant. Only gvc0 publicly formalizes typed verify-failure routing into a separate planner-class agent.

## SARIF as the interop surface

SARIF (Static Analysis Results Interchange Format) is OASIS-standard JSON for issue payloads. GitHub Code Scanning, IDE extensions (VS Code's Problems panel), and most static-analysis tools consume it. By 2026-04 it's the de facto interchange format for "list of issues with locations and severity."

`VerifyIssue` already has the shape of a SARIF result: source, severity, location, message. Emitting an optional SARIF stream alongside the typed internal payload gives gvc0 free interop with:

- GitHub Code Scanning (verify failures show up as PR annotations).
- VS Code Problems panel (developers see them locally).
- Any downstream lint/security tool that already consumes SARIF.

This is internal-shape preserving: `VerifyIssue` stays the typed first-class payload; SARIF is a serialization format. See [sarif-verifyissue-output.md](../../feature-candidates/interop/sarif-verifyissue-output.md).

## What gvc0's verification model uniquely buys

- **Typed sources**: `verify | ci_check | rebase` is enough discrimination to route the replanner deterministically. No public competitor surfaces this distinction.
- **Replanner-as-agent**: the replanner is a separate agent class with its own prompt and tool surface. It's not "the same agent re-prompted with errors" — it has structurally different context.
- **Programmatic recovery**: `VerifyIssue` → replanner → graph mutation is a closed loop without human intervention for the common cases. Most competitors hand off to a human or re-prompt the same agent.

## Where verification is currently weak

- **Same-family blind spots are unaddressed.** The replanner shares model family with the planner today; arXiv 2604.19049 is the empirical case for changing this.
- **No external interop.** `VerifyIssue` is internal-only. SARIF output would close that gap.
- **No formal evaluation.** gvc0 does not have a measured benchmark of replanner-recovery rate. Worth establishing once SWE-Bench Pro stabilizes.

## Public references

- arXiv 2604.19049: <https://arxiv.org/abs/2604.19049>
- SWE-Bench Verified audit (OpenAI): <https://openai.com/index/swe-bench-verified-audit-2026/>
- SARIF spec: <https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html>
- GitHub Code Scanning (SARIF consumer): <https://docs.github.com/en/code-security/code-scanning>

## Adoption status

| Rec | Status | Commit | Notes |
| --- | --- | --- | --- |
| Pin replanner to a different model family than the planner (cross-family blind spots) | deferred | — | See [cross-family-replanner.md](../../feature-candidates/coordination/cross-family-replanner.md). |
| Emit SARIF stream alongside `VerifyIssue` payload for external interop | deferred | — | See [sarif-verifyissue-output.md](../../feature-candidates/interop/sarif-verifyissue-output.md). |
| Defer benchmark-driven quality claims until SWE-Bench Pro stabilizes | done | — | No Verified-score claims made in public materials; decision is standing policy. |
| Establish measured replanner-recovery-rate baseline once SWE-Bench Pro is available | open | — | No benchmark infrastructure yet; blocked on SWE-Bench Pro leaderboard. |

## Revisit notes

Worth revisiting after:

- Cross-family replanner ships (measure recovery rate before/after).
- SARIF output ships (measure downstream-tool integrations adopted).
- SWE-Bench Pro publishes its first leaderboard.
- A successor to arXiv 2604.19049 measures whether typed verify-failure routing changes the same-family blind-spot story.
