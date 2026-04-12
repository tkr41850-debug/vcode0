# Worker Agent

The worker agent is the pi-sdk `Agent` that runs inside each task child process. It owns:

- **Tool catalog** — the `AgentTool` implementations a worker can call.
- **Toolset factory** — assembles the catalog with runtime-provided dependencies (IPC bridge, worktree path, task identifiers).

The *system prompt* for the worker lives in `src/runtime/worker/` because it is assembled from runtime-owned `WorkerContext` inputs (plan summary, dependency outputs, codebase map) and handed directly to the harness. Only the tool-layer behavior lives here.

## Layout

```
src/agents/worker/
├── README.md
├── toolset.ts      factory: buildWorkerToolset(deps) → AgentTool[]
└── tools/
    ├── submit.ts
    ├── confirm.ts
    ├── request-help.ts
    ├── request-approval.ts
    ├── append-knowledge.ts
    ├── record-decision.ts
    ├── read-file.ts
    ├── write-file.ts
    ├── edit-file.ts
    ├── list-files.ts
    ├── search-files.ts
    ├── run-command.ts
    ├── git-status.ts
    └── git-diff.ts
```

Each tool lives in its own file and exports a single factory function that closes over the deps it needs.

## Dependency Injection

Tools that need to talk to the orchestrator (blocking tools, task-lifecycle tools) receive an `IpcBridge` — a narrow seam that hides the transport, the pending-response map, and the task/run identifiers behind a few methods:

```ts
export interface IpcBridge {
  readonly taskId: string;
  readonly agentRunId: string;

  /** Send a progress notification (fire-and-forget). */
  progress(message: string): void;

  /** Request help from the operator; resolves when the response arrives. */
  requestHelp(query: string): Promise<HelpResponse>;

  /** Request approval from the operator; resolves when the decision arrives. */
  requestApproval(payload: ApprovalPayload): Promise<ApprovalDecision>;

  /** Emit the terminal result for this task. */
  submitResult(result: TaskResult): void;
}
```

Tools that only touch the worktree filesystem (`read_file`, `write_file`, `edit_file`, `list_files`, `search_files`, `run_command`, `git_status`, `git_diff`) receive a `workdir: string` and nothing else.

Knowledge tools (`append_knowledge`, `record_decision`) receive the project root so they can find `.gvc0/KNOWLEDGE.md` and `.gvc0/DECISIONS.md`.

## Tool Families

### Task Lifecycle

| Tool | Description |
|------|-------------|
| `submit` | Signal task completion. Sends a `result` IPC message with the summary and files changed. The worker agent is expected to call this exactly once when done. Distinct from the planner's `submit` tool which finalizes a planning session. |
| `confirm` | Finalize after successful `submit()`. Orchestrator-side merging is handled by the scheduler; this tool is a marker the worker uses to indicate it has verified its own work locally. |

### Collaboration (Blocking)

These tools return a `Promise` that resolves when the orchestrator replies via IPC. The pi-sdk agent naturally pauses because the tool call has not returned.

| Tool | Description |
|------|-------------|
| `request_help` | Ask the human operator for guidance. Blocks until `help_response` arrives. |
| `request_approval` | Request approval for a destructive or replan action. Blocks until `approval_decision` arrives. |

### Knowledge

| Tool | Description |
|------|-------------|
| `append_knowledge` | Append a lesson or pattern to `.gvc0/KNOWLEDGE.md`. |
| `record_decision` | Append an architectural decision + rationale to `.gvc0/DECISIONS.md`. |

### File Operations

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents relative to the worktree root. |
| `write_file` | Write a file. Creates parent directories as needed. |
| `edit_file` | Apply an ordered list of string replacements to a file. |
| `list_files` | List files matching a glob pattern in the worktree. |
| `search_files` | Search file contents with a regex (ripgrep-free fallback scanner). |

### Command Execution

| Tool | Description |
|------|-------------|
| `run_command` | Execute a shell command in the worktree. Captures stdout, stderr, and exit code as the tool result. |

### Git Inspection (Read-Only)

| Tool | Description |
|------|-------------|
| `git_status` | Return `git status --porcelain=v1` for the worktree. |
| `git_diff` | Return diff against a reference (default: `HEAD`). |

## Name Collision Note

The planner agent has its own `submit` tool (defined in `src/agents/tools/`) that means "planner is done creating the DAG." The worker `submit` tool means "task work is done, run verification." These are separate families — planner tools live in `@agents/tools`, worker tools live in `@agents/worker/tools`.
