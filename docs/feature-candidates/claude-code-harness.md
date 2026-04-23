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

## Stream-json Parsing

`stream-json` is an NDJSON event stream with several event kinds (`system`, `assistant`, `user`, `result`, `tool_use`, `tool_result`, plus hook events when `--include-hook-events` is set). The harness parses it and routes into the existing `WorkerToOrchestratorMessage` shapes so the orchestrator/TUI see Claude Code workers the same way they see `PiSdkHarness` workers.

The parser is not optional. It is needed for:

- **TUI output**: map `assistant` text blocks to `assistant_output` and turn boundaries to `progress`. Without parsing, the operator sees a blank scoreboard while the worker runs.
- **Usage accounting**: the terminal `result` event carries the authoritative `usage` block (tokens, cache, cost hints). Only source for `RuntimeUsageDelta`.
- **Error classification**: subprocess exit code alone cannot distinguish a clean finish from an agent-side error. The `result` event's `subtype` (e.g. `success` vs `error_during_execution`) disambiguates; map to `result` / `error` IPC frames accordingly.
- **Audit log**: `PostToolUse` hook events carry the paths and commands that actually ran. Feeds the events table for forensics and cross-checks the `filesChanged` that `submit` reports at merge-train time.
- **Tool-use visibility**: real-time `tool_use` / `tool_result` events drive the operator's live view of what the worker is doing, matching the turn-level visibility `PiSdkHarness` already provides.

Terminal task signalling does **not** go through stream-json: `submit` is an orchestration MCP tool, so the orchestrator learns about completion directly from the MCP server and uses the stream-json `result` event only to finalize usage and detect errors.

Parser lives with the harness (e.g. `src/runtime/harness/claude-code/stream-json.ts`). TypeBox-validate inbound events, reject unknown shapes loudly during development, and keep a thin mapping layer so the rest of the runtime stays transport-agnostic.

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

## Baseline Decisions

Concrete choices for the first implementation pass. Flagged as defaults; revisit only if operational reality forces.

### Tool surface

- **Orchestration-only MCP**. Expose via `mcp__gvc0__*` namespace: `submit`, `request_help`, `request_approval`, `raiseIssue`, feature-phase `submitDiscuss/Research/Summarize/Verify`, planner proposal tools, and knowledge/decision writes (`appendKnowledge`, `recordDecision`). No MCP wrappers around built-ins.
- **Built-ins via allowlist**, not replaced. File/command work uses Claude Code's `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`.
- **No `reserve_write` MCP tool**. Path coordination lives in the `PreToolUse` hook (see below), not in a model-cooperative tool.
- Baseline allowlist:

  ```
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(*),mcp__gvc0__*"
  ```

- Baseline `permissions.deny` / `permissions.allow` rules (in settings file passed via `--settings`):
  - `Write(/**)` deny + `Write(<worktree-abs>/**)` allow — prevents absolute-path escape out of worktree (`pi-sdk`'s `resolveInsideWorkdir` equivalent).
  - `Edit(/**)` deny + `Edit(<worktree-abs>/**)` allow — same reasoning.
  - `Bash(rm -rf:*)`, `Bash(git push:*)`, `Bash(sudo:*)` deny.
  - `Bash(cd /:*)`, `Bash(cd ~:*)` deny (investigate Claude Code's `Bash` cwd semantics before locking in — if Bash inherits shell-state cd across calls, tighten; if each call starts from the declared cwd, the deny is belt-and-suspenders).
  - `Write(/**/.env*)` deny.
  - `Write(/**/.ssh/**)`, `Read(/**/.ssh/**)` deny.
  - Knowledge/decision writes go through MCP tools (`appendKnowledge`, `recordDecision`), not `Write` — `<projectRoot>/.gvc0/**` stays denied for `Write`.

### Write-prehook path coordination

- `PreToolUse` hook on `Write` / `Edit` / `Bash` blocks synchronously against the orchestrator's local HTTP endpoint (see MCP server lifecycle below for why HTTP), equivalent to the current pi-sdk `claim_lock` flow. Hook returns `{"permissionDecision":"allow|deny", ...}` on **every** code path — unit-tested to guarantee valid JSON even on IPC errors or timeouts (fail-closed to `deny` with actionable `reason`).
- `PostToolUse` hook logs touched paths and commands into the events table for forensics and to cross-check `filesChanged` at merge-train time.
- Runtime overlap detection for the Claude Code harness is intact via this path; same entry points (`handleSameFeatureOverlap`, `handleCrossFeatureOverlap`) fire as for `PiSdkHarness`.

### Permission mode

- `--permission-mode default` (or `bypassPermissions`) with the `PreToolUse` hook as the authoritative gate. Exact choice depends on whether `default` falls back to interactive prompt when a hook returns non-standard JSON — verify against the Claude Code source before locking in. Hook unit tests cover every return path to avoid the fallback firing in practice.

### Human-in-the-loop

- `request_approval` is a blocking MCP tool. Orchestrator holds the response; MCP handler awaits.
- **10-minute timeout** on human wait. On expiry, orchestrator kills the Claude Code subprocess, marks the run `awaiting_human`, and respawns via `--resume` once the decision lands.

### MCP server lifecycle

- **HTTP transport, orchestrator-hosted**. Single long-lived MCP server inside (or as a child of) the orchestrator process, listening on `127.0.0.1:<port>` and wired via Claude Code's `--mcp-config` with `{"type":"http","url":"http://127.0.0.1:<port>/mcp/<agentRunId>","headers":{"Authorization":"Bearer <token>"}}`. Per-worker scope is routed by URL path + bearer token keyed to `agentRunId`.
- Benefit over stdio: MCP tool handlers call orchestrator state directly (no Unix socket, no cross-process IPC for `submit`/`request_help`/`request_approval`). Scope gating (see below) resolves against the orchestrator's in-memory run registry at call time.
- **Concurrent blocking tool calls per worker are supported**: the Anthropic API emits parallel tool uses, so the server keys pending responses by MCP `tool_use_id` (same pattern the current `pendingClaims` map uses for `claim_lock`). The one-at-a-time restriction on `request_help` / `request_approval` in the pi-sdk `WorkerRuntime` is a legacy code quirk, not architectural; do not carry it into the HTTP MCP server.
- Trust boundary: localhost-bind only, per-worker bearer token. Token leak grants remote tool invocation on behalf of that one worker's scope; not a cross-worker escalation.
- Crash handling: if the MCP HTTP server dies, every in-flight worker stalls on its next tool call. Treat as orchestrator-level failure (not per-worker) — restart the server; in-flight Claude Code subprocesses fail their pending tool calls, get marked failed, and retry. Mirrors other orchestrator-shared-infra crashes.
- Stdio MCP per worker is rejected as the baseline: adds a side channel to reach orchestrator state, duplicates process per task, and doesn't improve isolation beyond what the bearer-token scope already provides.

### Scope gating

- The same MCP server serves task workers, feature-phase agents, and planner agents. The tool set exposed for a given worker is gated by its scope.
- Worker subprocess spawn passes `GVC_SCOPE_TYPE=task|feature_phase|planner` plus `GVC_PHASE` (when `feature_phase`) in env; the orchestrator records the same on the `agent_runs` row and associates it with the bearer token minted for that worker.
- On each HTTP MCP request, the server resolves `agentRunId` → scope → allowed tool set. Tools outside the scope return MCP `method_not_found`. Prevents e.g. a task worker calling `submitVerify` or a verify-phase agent calling `submit`.
- Tool subsets:
  - `task`: `submit`, `request_help`, `request_approval`, `appendKnowledge`, `recordDecision`.
  - `feature_phase` (phase-specific): `submitDiscuss`/`submitResearch`/`submitSummarize`/`submitVerify`, `raiseIssue`, inspection tools, plus `request_help`/`request_approval`.
  - `planner`: proposal mutation tools (`addMilestone`/`addFeature`/…/`submit`), inspection tools, `request_help`/`request_approval`.

### Suspend / resume

- **Immediate** suspend only in baseline: SIGTERM the subprocess. Any partial turn is lost; last completed turn persists in session jsonl.
- Resume: new `claude -p --resume <session-id>` with the steering directive as the `-p` prompt (same content the current pi-sdk `formatResumeMessage` produces).
- Retry branches: `--fork-session` off the last good session id. GC pass on feature merge-to-main deletes orphaned session jsonls for that feature's worktrees.
- Graceful mid-turn suspend is deferred; see [optimization-candidates/graceful-claude-code-suspend.md](../optimization-candidates/graceful-claude-code-suspend.md).

### Orphaned subprocess recovery

- Orchestrator stores subprocess PID + boot epoch on `agent_runs`. Startup reconciler kills stale PIDs belonging to prior orchestrator instances before attempting resume. Prevents zombie Claude Code processes after orchestrator crash.

### Usage accounting

- Parse the `result` event's `usage` block from `stream-json` into `RuntimeUsageDelta`. Tag `rawUsage` with auth-mode (`oauth_max_plan` vs `api_key`) so budget rollup does not double-count OAuth max-plan sessions as paid API usage.

### Model selection

- Model pinned per subprocess via `--model`. Tier escalation requires a respawn (acceptable; escalations are rare). Document the respawn path in the model router when wiring.

### System prompt + CLAUDE.md

- `--append-system-prompt-file <rendered>` is the authoritative per-task context, always passed. Independent of CLAUDE.md presence.
- Repo-root `CLAUDE.md` loads via Claude Code's upward directory walk when present on the checked-out branch of a parent worktree. No fallback file is written when absent; the task prompt stands alone.
- User-level `~/.claude/CLAUDE.md` contamination is mitigated via the `claudeMdExcludes` settings key (the narrowest documented mechanism). In the harness-generated `--settings` file:

  ```json
  { "claudeMdExcludes": ["<user-home>/.claude/CLAUDE.md"] }
  ```

  Excludes only the user file by absolute path, leaves repo `CLAUDE.md`, plugins, hooks, and auto-memory intact. `--bare` / `CLAUDE_CODE_SIMPLE=1` is rejected (strips plugins + hooks + MCP + auto-memory as collateral). `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` is also too broad (drops project CLAUDE.md too). Source: [Claude Code memory docs](https://code.claude.com/docs/en/memory) — "Exclude specific CLAUDE.md files".

### Settings isolation

- `--settings <abs-path>` points at a gvc0-generated settings file with absolute hook paths baked in (reproducible across worktrees).
- `--setting-sources project,local` excludes the user-level `settings.json` layer, so operator personal settings cannot perturb worker behavior. Note: this flag controls `settings.json` hierarchy only; the CLAUDE.md memory hierarchy is governed separately (see above).

### Session identity

- Session ids are orchestrator-assigned UUIDs via `--session-id`. Session jsonl persists at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`; orchestrator stores the cwd alongside `agent_runs.session_id` to avoid slug-mismatch on resume.

### Binary discovery + version compatibility

- `claude` binary resolved from `CLAUDE_CODE_BINARY` env var first, then PATH. gvc0 config key `harness.claudeCode.binary` overrides both.
- Version compatibility is best-effort, not fail-fast. At harness startup:
  - Probe `claude --version`.
  - Compare against the harness's tested range using `semver` (pin a hard floor; soft-warn above the tested upper bound).
  - Log a warning (not an error) when outside the tested range; continue.
- Stream-json parser tolerates unknown event types (skip-and-warn rather than throw) so schema additions in newer Claude Code versions don't break running harnesses. Known event types are typed strictly; unknown types are logged once per kind per session.

### Dispatch-port generalization

- `RuntimePort.dispatchTask` today only covers task workers; feature-phase and planner runs share `agent_runs` + sessions but route through separate execution paths (see the existing memory on the feature-phase execution gap). Generalize the port as part of this baseline: `dispatchRun({ scope: 'task' | 'feature_phase' | 'planner', agentRunId, ... })`. Closes the pre-existing gap and gives the Claude Code harness one entry point to serve all three scopes uniformly.
- Harness selection therefore applies per-scope or globally (see next subsection); baseline is global but the generalized port makes per-scope trivial if a rollout wants it.

### Harness selection

- Swap site: `src/compose.ts` currently instantiates `PiSdkHarness` directly. Introduce config-driven selection there.
- gvc0 config adds a top-level `harness` section:

  ```ts
  harness: {
    kind: 'pi-sdk' | 'claude-code',  // default: 'pi-sdk'
    claudeCode?: {
      binary?: string,               // override CLAUDE_CODE_BINARY / PATH
      settings?: string,             // absolute path to --settings file
      mcpServerPort?: number,        // fixed port; otherwise orchestrator picks
    },
  }
  ```

- Baseline scope: global harness selection (all workers use one backend). Per-feature or per-task harness selection is a follow-on feature candidate if real use cases emerge.

### Signal propagation

- On orchestrator shutdown or worker abort, SIGTERM the Claude Code subprocess. Verify Claude Code propagates SIGTERM to its child processes (MCP server, hook scripts, active Bash tool invocations) via `child.on('exit', ...)` observation during integration tests.
- Orchestrator tracks subprocess PID + MCP-session bearer-token in `agent_runs`. On startup reconciler pass, kill stale PIDs from prior orchestrator instances and revoke their tokens before attempting resume.

### Observability

- Claude Code writes its own logs under `~/.claude/logs/`. Orchestrator does not aggregate these; instead it records the Claude Code log file path in `agent_runs.extra` (or equivalent) so operators can `tail` the correct file when debugging a specific run.
- Per-run stream-json events already flow into the events table (via the parser) so the TUI's existing per-run view remains the primary debugging surface.

## Testing

- **Integration tests** mock the `claude` binary itself: a lightweight Node script that ingests stream-json on stdin and emits scripted stream-json on stdout per scenario. Point the harness at it via `CLAUDE_CODE_BINARY` during tests.
- Mock exposes the same session-id / `--resume` / `--fork-session` contract the real CLI does, driven by a fixture directory that mirrors `~/.claude/projects/<slug>/<session-id>.jsonl` layout.
- `fauxModel`-equivalent scripting at the Claude API layer (to exercise a real `claude` binary deterministically) is a follow-on; not required for baseline harness integration tests.
- **Unit tests** cover the stream-json parser (every known event type + unknown-kind skip-and-warn), the `PreToolUse` hook (every return path yields valid JSON), and the MCP server scope-gating table.

## Related

- [Worker Model](../architecture/worker-model.md) — baseline harness abstraction
- [test_claude_code_harness](../../specs/test_claude_code_harness.md) — scenario spec
- [Claude Code headless docs](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [MCP](https://code.claude.com/docs/en/mcp)
