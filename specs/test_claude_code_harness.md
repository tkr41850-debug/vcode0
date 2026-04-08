# test_claude_code_harness

## Goal

Capture the baseline behavior expected from a Claude Code-backed worker harness.

## Scenarios

### Claude Code worker starts as its own isolated session
- Given a task is assigned to `ClaudeCodeHarness`
- When the worker starts
- Then the harness creates or resumes an isolated Claude Code worker session for that task
- And it does not reuse planner-owned subagents as task workers

### Claude Code worker resumes from stored session id after restart
- Given a running task has a persisted Claude Code session id
- When the orchestrator restarts and recovers orphaned tasks
- Then the harness resumes that worker session by id if possible
- And rebases the task worktree onto the current feature branch before continuing

### Claude Code steering uses a resumptive checkpoint model
- Given a Claude Code worker reaches a model-turn boundary
- When the orchestrator wants to nudge it to continue or use verify/submit
- Then the harness resumes the same task session with follow-up guidance
- And does not require undocumented live mid-turn steering support

### Claude Code repair work uses worker-owned sessions
- Given a task or feature needs follow-up repair work after verification or merge-train failure
- When the orchestrator schedules that repair
- Then the repair runs in its own isolated Claude Code worker session
- And sandbox boundaries remain explicit per worker session
