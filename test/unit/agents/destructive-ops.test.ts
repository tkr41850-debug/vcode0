import type {
  AgentContext,
  BeforeToolCallContext,
} from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';

import {
  DESTRUCTIVE_PATTERNS,
  describeDestructive,
  destructiveOpGuard,
} from '@agents/worker/destructive-ops';

/**
 * Plan 03-04, Task 3: exercise the two destructive-op surfaces —
 *  1) `describeDestructive` (pure pattern matcher, testable in isolation)
 *  2) `destructiveOpGuard` (pi-sdk `beforeToolCall` hook adapter)
 */
describe('DESTRUCTIVE_PATTERNS', () => {
  it('covers the three git labels (force-push / branch -D / reset --hard)', () => {
    const labels = new Set(DESTRUCTIVE_PATTERNS.map((p) => p.label));
    expect(labels).toContain('git push --force');
    expect(labels).toContain('git branch -D');
    expect(labels).toContain('git reset --hard');
  });
});

describe('describeDestructive (positive cases)', () => {
  const positive: string[] = [
    'git push --force',
    'git push origin main --force',
    'git push -f origin main',
    'git branch -D feat-x',
    'git branch --delete --force feat-x',
    'git reset --hard HEAD',
    'git reset --hard HEAD~3',
    '  git push origin main --force  ', // leading whitespace
  ];

  for (const cmd of positive) {
    it(`matches: ${cmd}`, () => {
      const result = describeDestructive(cmd);
      expect(result).not.toBeNull();
      expect(result?.label).toMatch(/git /);
    });
  }
});

describe('describeDestructive (negative cases)', () => {
  const negative: string[] = [
    'git push origin main',
    'git push --set-upstream origin main',
    'git branch -d feat-x', // lowercase -d is safe (no "-D")
    'git reset HEAD',
    'git reset --mixed',
    'npm test',
    'rm -rf /', // out of scope Phase 3 (see docs/concerns/destructive-ops-non-git.md)
  ];

  for (const cmd of negative) {
    it(`does not match: ${cmd}`, () => {
      expect(describeDestructive(cmd)).toBeNull();
    });
  }
});

describe('destructiveOpGuard', () => {
  function makeCtx(toolName: string, args: unknown): BeforeToolCallContext {
    return {
      assistantMessage: {} as BeforeToolCallContext['assistantMessage'],
      toolCall: {
        type: 'toolCall',
        id: 'tc-1',
        name: toolName,
      } as BeforeToolCallContext['toolCall'],
      args,
      context: {} as AgentContext,
    };
  }

  it('blocks run_command with destructive git op and surfaces a reason', async () => {
    const result = await destructiveOpGuard(
      makeCtx('run_command', { command: 'git push --force' }),
    );
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/destructive_op_requires_approval/);
    expect(result?.reason).toMatch(/git push --force/);
  });

  it('passes through non-destructive commands', async () => {
    const result = await destructiveOpGuard(
      makeCtx('run_command', { command: 'npm test' }),
    );
    expect(result).toBeUndefined();
  });

  it('passes through non-run_command tools (write_file, edit_file, ...)', async () => {
    const result = await destructiveOpGuard(
      makeCtx('write_file', {
        path: 'out.txt',
        content: 'hello',
      }),
    );
    expect(result).toBeUndefined();
  });

  it('passes through when args.command is not a string', async () => {
    const result = await destructiveOpGuard(
      makeCtx('run_command', { command: 42 }),
    );
    expect(result).toBeUndefined();
  });
});
