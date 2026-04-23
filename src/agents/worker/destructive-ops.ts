import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@mariozechner/pi-agent-core';

// === Destructive-op guard (plan 03-04) ===
// Pure agent-layer detection of irreversibly-destructive git invocations that
// the AI might emit via `run_command`. The guard plugs into pi-sdk's
// `beforeToolCall` hook (see src/runtime/worker/index.ts) and returns
// `{ block: true, reason }` to abort the tool call before any side effects.
//
// Scope is intentionally narrow: ONLY git push --force, git branch -D, and
// git reset --hard (REQ-EXEC-04 per CONTEXT §D / RESEARCH §Destructive-Op
// Detection).
//
// OUT OF SCOPE for Phase 3 — deferred to Phase 7 (see
// docs/concerns/destructive-ops-non-git.md):
//   - `rm -rf <path>` / `rm -rf /`
//   - `find ... -delete`
//   - `dd if=... of=...`
//   - `mkfs.*`
//   - `truncate <path>`
//   - `chmod -R 000 <path>` / `sudo *`
//
// Known false-positive set (erring on the safe side per CONTEXT §D):
//   - `echo "git push --force"` — harmless at execute-time but matched; the
//     operator can approve out-of-band via the inbox_items round-trip.
//   - `git config alias.yolo "push --force"` — same reasoning.
// Acceptable: false-positives route to inbox approval, they do not crash.
//
// This module has NO side effects and MUST NOT import from @runtime,
// @persistence, or @orchestrator — it is a pure detection function.

export const DESTRUCTIVE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /\bgit\s+push\s+.*(--force\b|-f\b)/, label: 'git push --force' },
  {
    pattern: /\bgit\s+branch\s+.*(-D\b|--delete\s+--force\b)/,
    label: 'git branch -D',
  },
  { pattern: /\bgit\s+reset\s+.*--hard\b/, label: 'git reset --hard' },
];

/**
 * Pure helper: returns `{ label }` for the first matched destructive
 * pattern, or `null` if the command is safe (by our Phase 3 scope).
 *
 * Exported for unit-test coverage (see test/unit/agents/destructive-ops.test.ts).
 */
export function describeDestructive(cmd: string): { label: string } | null {
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) return { label };
  }
  return null;
}

/**
 * pi-sdk `beforeToolCall` hook implementation: if the tool is `run_command`
 * and the `command` argument matches a destructive pattern, return
 * `{ block: true, reason }`. Otherwise return `undefined` to pass through.
 *
 * pi-sdk emits an error tool-result to the agent when blocked; the wiring
 * in src/runtime/worker/index.ts additionally fires `ipc.requestApproval`
 * so the orchestrator appends an `inbox_items` row (REQ-EXEC-04 stub).
 */
export async function destructiveOpGuard(
  ctx: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
  if (ctx.toolCall.name !== 'run_command') return undefined;
  const cmd = (ctx.args as { command?: unknown } | undefined)?.command;
  if (typeof cmd !== 'string') return undefined;
  const match = describeDestructive(cmd);
  if (match === null) return undefined;
  return {
    block: true,
    reason: `destructive_op_requires_approval: ${match.label}`,
  };
}
