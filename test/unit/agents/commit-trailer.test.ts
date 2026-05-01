import {
  isGitCommitCommand,
  maybeInjectTrailer,
  validateTrailers,
} from '@agents/worker/tools/commit-trailer';
import { describe, expect, it } from 'vitest';

const TASK_ID = 'task-1234';
const RUN_ID = 'run-abcd';

describe('maybeInjectTrailer', () => {
  it('rewrites a plain git commit command with both trailers', () => {
    const rewritten = maybeInjectTrailer(
      'git commit -m "feat: initial"',
      TASK_ID,
      RUN_ID,
    );
    expect(rewritten).toContain(`gvc0-task-id=${TASK_ID}`);
    expect(rewritten).toContain(`gvc0-run-id=${RUN_ID}`);
    expect(rewritten).toMatch(/--trailer\s+"gvc0-task-id=task-1234"/);
    expect(rewritten).toMatch(/--trailer\s+"gvc0-run-id=run-abcd"/);
  });

  it('is idempotent when both trailers already appear', () => {
    const first = maybeInjectTrailer(
      'git commit -m "feat: initial"',
      TASK_ID,
      RUN_ID,
    );
    const second = maybeInjectTrailer(first, TASK_ID, RUN_ID);
    expect(second).toBe(first);
  });

  it('injects only the missing trailer when one is already present', () => {
    const input = `git commit -m "feat" --trailer "gvc0-task-id=${TASK_ID}"`;
    const rewritten = maybeInjectTrailer(input, TASK_ID, RUN_ID);
    // Only the run-id trailer should be appended — the task-id trailer was
    // already present, so we must not emit a duplicate.
    const taskOccurrences = rewritten.match(/gvc0-task-id=/g) ?? [];
    expect(taskOccurrences.length).toBe(1);
    expect(rewritten).toContain(`gvc0-run-id=${RUN_ID}`);
  });

  it('does not rewrite non-git-commit commands', () => {
    expect(maybeInjectTrailer('npm test', TASK_ID, RUN_ID)).toBe('npm test');
    expect(maybeInjectTrailer('git status', TASK_ID, RUN_ID)).toBe(
      'git status',
    );
    expect(maybeInjectTrailer('git log -5', TASK_ID, RUN_ID)).toBe(
      'git log -5',
    );
    expect(maybeInjectTrailer('git show HEAD', TASK_ID, RUN_ID)).toBe(
      'git show HEAD',
    );
  });

  it('tolerates leading whitespace and still detects git commit', () => {
    const rewritten = maybeInjectTrailer(
      '   git commit -m "feat"',
      TASK_ID,
      RUN_ID,
    );
    expect(rewritten).toContain(`gvc0-task-id=${TASK_ID}`);
    expect(rewritten).toContain(`gvc0-run-id=${RUN_ID}`);
  });

  it('rewrites a bare git commit with no arguments', () => {
    const rewritten = maybeInjectTrailer('git commit', TASK_ID, RUN_ID);
    expect(rewritten).toContain(`gvc0-task-id=${TASK_ID}`);
    expect(rewritten).toContain(`gvc0-run-id=${RUN_ID}`);
  });
});

describe('isGitCommitCommand', () => {
  it('matches plain git commit invocations', () => {
    expect(isGitCommitCommand('git commit')).toBe(true);
    expect(isGitCommitCommand('git commit -m "feat"')).toBe(true);
    expect(isGitCommitCommand('   git commit -m x')).toBe(true);
  });

  it('rejects non-git-commit invocations', () => {
    expect(isGitCommitCommand('git status')).toBe(false);
    expect(isGitCommitCommand('git log')).toBe(false);
    expect(isGitCommitCommand('git show')).toBe(false);
    expect(isGitCommitCommand('npm test')).toBe(false);
    expect(isGitCommitCommand('commit -m x')).toBe(false);
    expect(isGitCommitCommand('')).toBe(false);
  });
});

describe('validateTrailers', () => {
  it('returns true when both trailers are present with expected values', () => {
    const output = `gvc0-task-id: ${TASK_ID}\ngvc0-run-id: ${RUN_ID}\n`;
    expect(validateTrailers(output, TASK_ID, RUN_ID)).toBe(true);
  });

  it('returns false when task trailer value does not match', () => {
    const output = `gvc0-task-id: other-task\ngvc0-run-id: ${RUN_ID}\n`;
    expect(validateTrailers(output, TASK_ID, RUN_ID)).toBe(false);
  });

  it('returns false when run trailer is missing', () => {
    const output = `gvc0-task-id: ${TASK_ID}\n`;
    expect(validateTrailers(output, TASK_ID, RUN_ID)).toBe(false);
  });

  it('returns false on empty output', () => {
    expect(validateTrailers('', TASK_ID, RUN_ID)).toBe(false);
  });

  it('is case-insensitive on trailer keys', () => {
    const output = `GVC0-TASK-ID: ${TASK_ID}\nGvc0-Run-Id: ${RUN_ID}\n`;
    expect(validateTrailers(output, TASK_ID, RUN_ID)).toBe(true);
  });
});
