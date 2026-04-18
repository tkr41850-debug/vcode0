# Feature Candidate: Claude Code Harness

## Status

Future feature candidate. Do not treat as part of baseline architecture yet.

## Baseline

Baseline worker harness is `PiSdkHarness`, running pi-sdk `Agent` instances directly with full programmatic control over start, resume, steer, and tool dispatch.

## Candidate: ClaudeCodeHarness

A `ClaudeCodeHarness` would wrap Claude Code CLI sessions as worker backends, letting tasks execute inside Claude Code's environment with its permission system, hooks, skills, and MCP ecosystem.

### Motivation

- **Leverage Claude Code UX**: terminal flow, permission prompts, hooks, skills
- **Reuse familiar tooling**: users already know Claude Code workflows
- **Isolation**: sessions provide sandboxed execution boundaries
- **Ecosystem**: reuse MCP servers, subagents, skills, commands

## Headless CLI Surface

Claude Code is driveable headlessly via `claude -p`. The orchestrator would spawn one process per task/turn and coordinate via flags + stdio.

### Core invocation

```bash
claude -p "prompt" \
  --output-format stream-json \
  --input-format stream-json \
  --include-partial-messages \
  --include-hook-events \
  --verbose
```

`--output-format` choices:
- `text` (default)
- `json` — single final JSON object (includes `session_id`, usage)
- `stream-json` — NDJSON event stream suitable for piping into an orchestrator

`--input-format stream-json` accepts NDJSON messages on stdin — the documented path for multi-turn programmatic input without relaunching the process.

### Session lifecycle

- `--session-id <uuid>` — assign a deterministic session id at spawn (orchestrator can pick its own)
- `--continue` / `-c` — resume most recent session in cwd
- `--resume <id|name>` / `-r` — resume specific session
- `--fork-session` — branch off a session (cheap "checkpoint" model for retries)
- `--name <name>` — human label
- `--no-session-persistence` — ephemeral one-shot runs

Sessions still persist to `~/.claude/projects/<slug>/*.jsonl`. With `--session-id` the orchestrator no longer needs to parse that directory to learn the id.

### Permissions

- `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`
  - `plan` runs Claude Code in plan mode (no writes/tool execution)
  - `acceptEdits` auto-approves file edits
  - `dontAsk` / `bypassPermissions` skip prompts (use with strict allowlist)
- `--allowedTools "Read,Glob,Grep,Bash(npm run *)"` — preapprove specific tools/rules
- `--disallowedTools "Bash,Edit"` — remove tools from model context
- `--tools "Read,Glob,Grep"` — explicit allowlist (restricts built-ins primarily)
- `--permission-prompt-tool mcp__<server>__<tool>` — delegate interactive approvals to an MCP tool (see Human-in-the-loop below)

Settings file equivalents (`--settings` or `~/.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["Bash(npm run test:*)"],
    "deny": ["Bash(rm:*)", "Read(./secrets/**)"],
    "ask":  ["Bash(git push:*)"]
  }
}
```

### Config and isolation

- `--settings <path>` — use a specific settings file
- `--setting-sources user,project,local` — restrict which setting layers load
- `--bare` — strip all defaults (no `CLAUDE.md`, no plugins, no user hooks) for reproducible CI-style runs
- `--append-system-prompt` / `--system-prompt` (or `...-file` variants)
- `--model <id>` — pin model per harness invocation
- `--agents <path>` / `--agent <name>` — wire custom subagents

### Hook events

Set hook handlers in `settings.json`. Relevant for a harness:

- `PreToolUse` — can return `{"permissionDecision":"allow|ask|deny","updatedInput":...}`
- `PostToolUse` — notify orchestrator of completed tool calls
- `UserPromptSubmit` — intercept/rewrite prompts
- `SessionStart` / `Stop` — checkpoint orchestrator state

`--include-hook-events` emits hook events into the `stream-json` channel, giving the orchestrator visibility into every pre/post tool decision without custom plumbing.

## Human-in-the-loop Permission Forwarding

The orchestrator (or a human reviewer) can gate every tool call using one of:

1. **`--permission-prompt-tool`** — an MCP tool that Claude Code calls for each permission decision. Contract:
   - Input: `{toolName, input, ...}`
   - Return: `{behavior: "allow", updatedInput?}` or `{behavior: "deny", message?}`
   - Implementation blocks on a human channel (TTY prompt, Slack button, orchestrator IPC) and returns the verdict.
2. **`PreToolUse` hook** — bash script returning JSON with `permissionDecision`. Fires in `-p`. Cheapest option when no UI is needed.
3. **Agent SDK `canUseTool` callback** — cleanest when building a TS/Python wrapper around Claude Code's engine directly.

Note: `PermissionRequest` hooks do **not** fire in `-p`. Use `PreToolUse` or `--permission-prompt-tool` instead.

## MCP Integration (Custom Tools)

Custom tools in a `ClaudeCodeHarness` land via MCP servers — this is Claude Code's canonical extension surface.

### Wiring

Project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "gvc0-harness": {
      "command": "node",
      "args": ["/abs/path/to/harness-mcp.js"],
      "env": { "GVC_TASK_ID": "${TASK_ID}" }
    }
  }
}
```

Or per-invocation:

```bash
claude -p "..." \
  --mcp-config /path/to/mcp.json \
  --strict-mcp-config
```

`--strict-mcp-config` loads only the supplied file — no user/project MCP bleed-through. Ideal for isolated task workers.

### Context cost

MCP tools are not free, but the cost is usually small in current Claude Code:
- Tool search is on by default (see `/context` and `/mcp`): only tool **names** load at session start; schemas load on actual use
- Tool descriptions + server instructions are truncated to ~2KB each
- Heavier cases: `ENABLE_TOOL_SEARCH=false`, Haiku (no tool search), some non-first-party proxies
- Prune with `disabledMcpjsonServers` / `enabledMcpjsonServers` in settings, or `--disallowedTools mcp__server__tool`

Tools surface to the model as `mcp__<server>__<tool>`; allowlist with `--allowedTools "mcp__gvc0-harness__*"`.

### Harness → Claude Code tool surface

A `ClaudeCodeHarness` MCP server could expose:
- `submit` — worker signals task completion
- `request_help` — ask orchestrator for guidance (blocks)
- `mark_milestone` — surface progress to the planner
- `reserve_write` — request write-intent reservation (ties into write-prehook)
- `run_verify` — invoke feature verification command

Orchestrator reads these as tool calls in the `stream-json` channel and reacts accordingly.

## Removing / Replacing Built-ins

- **Remove**: `--disallowedTools "Bash,Edit,Write"` or `permissions.deny` rules
- **Full replace** (e.g., swap `Bash` implementation): not supported. Pattern: deny built-in + expose an MCP tool with a different name that does the equivalent under harness rules. Hooks can rewrite `PreToolUse` input but cannot swap implementation.
- **Narrow a built-in**: `permissions.allow: ["Bash(./scripts/harness-run.sh:*)"]` + `permissions.deny: ["Bash(*)"]`

## Lighter-weight Custom Extension Paths

For cases where MCP is overkill:
- **Bash allowlist** — cheapest; `permissions.allow: ["Bash(./scripts/x.sh:*)"]`, zero new tool surface
- **Skills** (`.claude/skills/`) — progressive disclosure, body loads on invocation
- **Hooks** — event-driven automation, no tool surface
- **Subagents** (`.claude/agents/`) — isolate noisy output in separate context

MCP remains the right answer when the harness needs typed external integration with state and blocking semantics (help requests, approvals, reservations).

## Implementation Approaches

**Option 1: CLI subprocess wrapper (recommended first pass)**
- Spawn: `claude -p --session-id <uuid> --output-format stream-json --input-format stream-json --mcp-config harness.mcp.json --strict-mcp-config --permission-prompt-tool mcp__gvc0-harness__approve ...`
- Resume: same with `--resume <uuid>` or `--fork-session`
- Steering: feed follow-up messages via stdin (stream-json) or resume with new `-p` turn
- Coordination: MCP tools + hook events on stream-json channel
- Session ids: orchestrator-assigned via `--session-id`
- Approval forwarding: `--permission-prompt-tool` routes to orchestrator IPC

**Option 2: Agent SDK with Claude Code tool parity**
- Skip the CLI; drive Claude Agent SDK directly
- Native `canUseTool` + streaming input
- Loses Claude Code-specific settings/hook/plugin ecosystem, keeps engine behavior

**Option 3: Fork Claude Code internals**
- Only if the CLI surface proves insufficient after building Option 1

### Recommendation

Option 1 is now viable with documented flags (was blocked on session-id/stream-json/permission-prompt-tool, all of which are now documented). Defer work until a concrete use case needs it, but plan the harness abstraction so a future `ClaudeCodeHarness` can slot in alongside `PiSdkHarness`.

## Related

- [Worker Model](../worker-model.md) — baseline harness abstraction
- [test_claude_code_harness](../../specs/test_claude_code_harness.md) — scenario spec
- [Claude Code headless docs](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [MCP](https://code.claude.com/docs/en/mcp)
