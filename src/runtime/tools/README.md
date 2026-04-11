# Worker Agent Tools

This directory will contain the pi-sdk `AgentTool` implementations available to task workers.

## Tool Families

### Task Lifecycle

| Tool | Signature | Description |
|------|-----------|-------------|
| `submit` | `(summary: string, filesChanged: string[])` | Signal task completion. Runs preflight verification checks, then emits a `result` IPC message. Distinct from the planner's `submit` tool which finalizes a planning session. |
| `confirm` | `()` | Finalize after successful `submit()`. Triggers squash-merge of the task worktree into the feature branch. |

### Collaboration (Blocking)

These tools pause the agent by returning a `Promise` that resolves when the orchestrator replies via IPC.

| Tool | Signature | Description |
|------|-----------|-------------|
| `request_help` | `(query: string)` | Ask the human operator for guidance. Sends `request_help` IPC message, blocks until `help_response` arrives. |
| `request_approval` | `(payload: ApprovalPayload)` | Request human approval for a destructive action or replan proposal. Blocks until `approval_decision` arrives. |

### Knowledge

| Tool | Signature | Description |
|------|-----------|-------------|
| `append_knowledge` | `(entry: string)` | Append a lesson or pattern to `.gvc0/KNOWLEDGE.md`. |
| `record_decision` | `(decision: string, rationale: string)` | Append an architectural decision to `.gvc0/DECISIONS.md`. |

### File Operations

| Tool | Signature | Description |
|------|-----------|-------------|
| `read_file` | `(path: string)` | Read file contents relative to the worktree root. |
| `write_file` | `(path: string, content: string)` | Write a file. Must respect `reservedWritePaths` constraints. |
| `edit_file` | `(path: string, edits: Edit[])` | Apply targeted edits to a file. Same path-lock semantics as `write_file`. |
| `list_files` | `(pattern?: string)` | List files matching a glob pattern in the worktree. |
| `search_files` | `(query: string, path?: string)` | Search file contents (ripgrep-style). |

### Command Execution

| Tool | Signature | Description |
|------|-----------|-------------|
| `run_command` | `(command: string, cwd?: string)` | Execute a shell command in the worktree. Output captured as tool result. Used for running tests, linters, build commands. |

### Git Inspection (Read-Only)

| Tool | Signature | Description |
|------|-----------|-------------|
| `git_status` | `()` | Return `git status` output for the task worktree. |
| `git_diff` | `(ref?: string)` | Return diff against a reference (default: HEAD). |

## IPC Interaction Patterns

### Blocking tools

`request_help` and `request_approval` use a pending-promise pattern:

1. Tool `execute()` sends an IPC message and returns a `Promise`
2. `WorkerRuntime` stores the promise resolver in a `Map<string, { resolve, reject }>`
3. When the matching IPC response arrives, `handleMessage()` resolves the promise
4. The pi-sdk Agent pauses naturally because the tool call hasn't returned

### Fire-and-forget tools

`append_knowledge`, `record_decision`, and all file/command tools operate locally on the worktree filesystem. No IPC round-trip needed.

### Write-lock tools

`write_file` and `edit_file` must coordinate with the overlap detection system. On first write to a new path, the tool should check `reservedWritePaths` and potentially signal the orchestrator via a progress message noting the paths being modified.

## Name Collision Note

The planner agent has its own `submit` tool (defined in `src/agents/tools/`) that means "planner is done creating the DAG." The worker `submit` tool here means "task work is done, run verification." These are separate tool families — planner tools live under `@agents`, worker tools live under `@runtime/tools`.
