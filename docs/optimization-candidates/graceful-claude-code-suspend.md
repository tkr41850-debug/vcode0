# Optimization Candidate: Graceful Claude Code Suspend

## Status

Future optimization candidate. Not part of baseline `ClaudeCodeHarness` wiring.

## Baseline

The baseline `ClaudeCodeHarness` suspends a worker by sending `SIGTERM` to the `claude -p` subprocess immediately when the orchestrator decides to pause the run (same-feature overlap, cross-feature overlap, approval timeout, operator action). Session state persists to `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` per-turn, so the **last completed turn** survives, but any partial turn in flight when SIGTERM arrives is lost. Resume respawns via `claude -p --resume <session-id>` with the steering directive as the `-p` prompt.

See [feature-candidates/claude-code-harness.md](../feature-candidates/claude-code-harness.md) — "Suspend / resume" under Baseline Decisions.

This is acceptable because cold-start is ~1-3s and partial-turn loss is rare; simpler flow beats graceful coordination for a first pass.

## Possible Future Optimization

Wait for the current turn to reach a natural checkpoint before killing the subprocess:

1. Read the `stream-json` event stream until a `result` event (turn end) or a `tool_result` event for a long-running tool completes.
2. Send `SIGTERM` only at that checkpoint, preserving the just-completed turn's in-memory state into the persisted jsonl.
3. Alternative: send a "pause after this turn" follow-up message via stream-json stdin and let the subprocess exit on its own, avoiding signals entirely.

Under this scheme, suspend latency becomes turn-bounded rather than instant, but no partial-turn work is lost.

## Caveat

Introduce only if partial-turn loss under overlap coordination causes noticeable operator churn (tasks repeating work after resume, approval flaps discarding expensive tool output). Measure first. The plumbing needs:

- A state machine on the harness side tracking "awaiting checkpoint" vs "terminating".
- A timeout/escalation path — some turns (long Bash, large reads) can take minutes, and operators will want the option to force-kill anyway.
- Coordination with approval-timeout semantics: graceful wait plus 10-minute approval timeout compounds — decide whether approval timeout preempts graceful wait or stacks on top.

The hardest part is that Claude Code's `-p` does not expose a documented "pause at next checkpoint" signal. The stream-json follow-up path is the cleanest primitive available, but its exact semantics (does the model respect a mid-stream user message as a hard stop, or incorporate it into the current turn?) need verification against Claude Code source before committing.

## Related

- [feature-candidates/claude-code-harness.md](../feature-candidates/claude-code-harness.md) — baseline harness decisions
- [architecture/worker-model.md](../architecture/worker-model.md) — suspend/resume IPC contract
