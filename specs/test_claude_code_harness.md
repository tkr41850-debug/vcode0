# test_claude_code_harness

## Status

Feature candidate. `ClaudeCodeHarness` is not part of baseline wiring — see
`docs/feature-candidates/claude-code-harness.md`. Baseline harness remains
`PiSdkHarness`. These scenarios capture the contract the harness should
satisfy if/when it lands.

## Goal

Capture the expected behavior of a Claude Code-backed worker harness
driven through the headless `claude -p` CLI surface.

## Scenarios

### Claude Code worker starts as its own isolated session
- Given a task is assigned to `ClaudeCodeHarness`
- When the worker starts
- Then the harness spawns `claude -p` with an orchestrator-assigned `--session-id`
- And uses `--output-format stream-json` with `--input-format stream-json` over stdio
- And the session is scoped to that task worktree

### Claude Code worker resumes from stored session id after restart
- Given a running task has a persisted Claude Code `session_id`
- When the orchestrator restarts and recovers orphaned tasks
- Then the harness resumes via `claude -p --resume <session_id>` if possible
- And rebases the task worktree onto the current feature branch before continuing

### Claude Code steering uses stream-json stdin between turns
- Given a Claude Code worker has finished emitting a turn's stream-json events
- When the orchestrator wants to nudge it to continue or use verify/submit
- Then the harness sends a follow-up user message as NDJSON on stdin
- And does not rely on live mid-turn steering

### Retry branches use session forking
- Given a task run needs to retry from an earlier point in its session
- When the orchestrator requests a retry branch
- Then the harness uses `--fork-session` off the base session id
- And the original session remains intact for reference

### Claude Code repair work uses worker-owned sessions
- Given a task or feature needs follow-up repair work after verification or merge-train failure
- When the orchestrator schedules that repair
- Then the repair runs in its own `claude -p` session with its own `--session-id`
- And sandbox boundaries remain explicit per worker session
