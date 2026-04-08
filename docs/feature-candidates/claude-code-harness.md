# Feature Candidate: Claude Code Harness

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline worker harness is `PiSdkHarness`, which runs pi-sdk `Agent` instances directly with full programmatic control over start, resume, steer, and tool dispatch.

## Candidate: ClaudeCodeHarness

A `ClaudeCodeHarness` would wrap Claude Code CLI sessions as worker backends, allowing tasks to execute in Claude Code's environment with its permission system, hooks, skills, and MCP ecosystem.

### Motivation

- **Leverage Claude Code UX**: terminal-based interaction, permission prompts, hooks, skills
- **Reuse existing tooling**: users already familiar with Claude Code workflows
- **Isolation**: Claude Code sessions provide sandboxed execution boundaries
- **Ecosystem**: access to Claude Code's MCP servers and extension points

### Implementation Challenges

Based on research into Claude Code's documented capabilities:

1. **Session ID retrieval**: Claude Code doesn't expose session IDs via CLI flags or JSON output. Session tracking would require parsing `~/.claude/projects/` JSONL files.

2. **Programmatic steering**: No documented IPC, stdin piping, or message-passing mechanism for injecting messages into a running Claude Code session from an external orchestrator.

3. **Subprocess coordination**: Claude Code is designed as an interactive terminal tool, not a subprocess you pipe into mid-execution.

4. **Approval forwarding**: No documented API for forwarding tool approvals between the orchestrator and Claude Code's permission system.

### Possible Approaches

**Option 1: CLI subprocess wrapper**
- Start: `claude "prompt"`
- Resume: `claude --resume <session>` (requires session ID from JSONL parsing)
- Coordinate via hooks: `PostToolUse` hook notifies orchestrator
- Limitations: no mid-session steering, no approval forwarding, clunky session management

**Option 2: Agent SDK with Claude Code tools**
- Use Anthropic Agent SDK directly
- Replicate Claude Code's tool set in the agent
- Bypass Claude Code CLI entirely
- Limitations: loses Claude Code UX, hooks, permission system

**Option 3: Fork Claude Code internals**
- Full control over session lifecycle
- Native approval forwarding
- Limitations: couples to Claude Code internals, maintenance burden

### Recommendation

Defer this feature until:
1. Claude Code exposes a documented orchestration API (JSON output, session IPC, approval forwarding), or
2. A clear use case emerges that requires Claude Code's specific UX/ecosystem and justifies the integration complexity

For now, `PiSdkHarness` provides the programmatic control needed for the baseline architecture.

## Related

- [Worker Model](../worker-model.md) — baseline harness abstraction
- [test_claude_code_harness](../../specs/test_claude_code_harness.md) — scenario spec for this candidate
