# Concern: Destructive ops — non-git commands not yet guarded

**Status:** documented concern, deferred to Phase 7+
**Introduced:** Phase 3 (worker execution loop, plan 03-04)
**Owner:** current Phase 3 planner / Phase 7 planner

## Concern

Phase 3's `destructiveOpGuard` (src/agents/worker/destructive-ops.ts) only
intercepts three git patterns:

- `git push --force` / `git push -f`
- `git branch -D` / `git branch --delete --force`
- `git reset --hard`

The following destructive shell operations are **not** currently guarded and
will execute if the AI emits them via `run_command`:

- `rm -rf <path>` — even `rm -rf /` (restrained only by `run_command` cwd;
  if the AI `cd`'s out first, it can affect the whole filesystem)
- `find <path> -delete`
- `dd if=... of=...` (overwriting block devices or files)
- `mkfs.*` (formatting filesystems)
- `truncate <path>` (zero-length any file)
- Arbitrary `sudo *` (mitigated only by no-root execution convention)
- `chmod -R 000 <path>` (locking out access)

## Why to Watch

`run_command` spawns `sh -c`, which can `cd /` and act outside the worktree
boundary that `resolveInsideWorkdir` enforces for file tools. A prompt-
injected or confused agent could silently wipe state that has no
equivalent "inbox approval" gate.

## What to Observe

- worker runs where `run_command` details contain `rm -rf`, `dd`, `mkfs`,
  or `find ... -delete`
- worker stderr mentioning `Permission denied` in directories not under
  the worktree (signal of a `cd ..` → destructive op attempt)
- inbox rows with `kind='destructive_action'` that reference the
  above patterns (they currently won't; this is a marker for detecting
  when Phase 7 expansion is wired)

## Why not fixed in Phase 3

- CONTEXT §D explicitly scoped destructive-op detection to git operations.
  RESEARCH §Open Questions #1 locks the deferral decision.
- The `rm -rf` pattern is hard to distinguish from legitimate workspace
  cleanup (`rm -rf node_modules`, `rm -rf dist`) without path-aware
  heuristics.
- Sandboxing (worker cwd constraints, UID separation) is a stronger
  defense than pattern matching and Phase 3 partially addresses it via
  `resolveInsideWorkdir` — but only for file tools, not `run_command`.

## Phase 7 expansion

When the inbox UI materializes, extend `destructiveOpGuard` with:

- `rm -rf`, `find -delete`, `dd`, `mkfs`, `truncate`, and `chmod -R 000`
  patterns.
- Path-aware heuristics: allow `rm -rf <x>` if `<x>` resolves inside the
  worktree; escalate otherwise.
- A user-editable allow-list of "safe" destructive patterns (e.g.,
  `rm -rf node_modules` may be pre-approved by policy).
- Consider promoting `run_command`'s shell invocation to spawn under a
  restricted UID or a tmpfs overlay for hard isolation, not just pattern
  rejection.

## Current Position

Phase 3 ships the git-only guard. The inbox row with
`kind='destructive_action'` is the extension point; Phase 7 owns the UI
and the expanded pattern set.

## Related

- `src/agents/worker/destructive-ops.ts` — the current guard.
- `src/runtime/worker/index.ts` — the pi-sdk `beforeToolCall` wiring.
- `.planning/phases/03-worker-execution-loop/RESEARCH.md` §Destructive-Op
  Detection — full scope discussion.
- `.planning/phases/03-worker-execution-loop/RESEARCH.md` §Open Questions
  #1 — the deferral decision.
- [Worker Runaway](./worker-runaway.md) — adjacent concern: a worker
  spinning on destructive retries burns both time and tokens.
