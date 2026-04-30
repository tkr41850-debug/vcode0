import { isDestructiveCommand } from '@agents/worker/destructive-ops';
import { describe, expect, it } from 'vitest';

describe('isDestructiveCommand', () => {
  it.each([
    'git push --force origin main',
    'git push -f origin feature',
    'git push origin main --force',
    'git branch -D feature/x',
    'git branch --merged main -D',
    'git reset --hard HEAD~1',
    'git reset HEAD~1 --hard',
    'cd /tmp && git push --force',
  ])('blocks %s', (cmd) => {
    const result = isDestructiveCommand(cmd);
    expect(result.match).toBe(true);
  });

  it.each([
    'git push --force-with-lease origin main',
    'git push --force-with-lease',
    'git push origin main',
    'git branch -d feature/x',
    'git branch --list',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git reset --mixed HEAD',
  ])('allows %s', (cmd) => {
    const result = isDestructiveCommand(cmd);
    expect(result.match).toBe(false);
  });

  it('returns the matched label so callers can show actionable feedback', () => {
    const push = isDestructiveCommand('git push --force origin main');
    expect(push).toEqual({ match: true, pattern: 'git push --force' });

    const branch = isDestructiveCommand('git branch -D feature/x');
    expect(branch).toEqual({ match: true, pattern: 'git branch -D' });

    const reset = isDestructiveCommand('git reset --hard HEAD~1');
    expect(reset).toEqual({ match: true, pattern: 'git reset --hard' });
  });
});
