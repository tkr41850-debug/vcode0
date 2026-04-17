import { resolveWorkerProjectRoot } from '@runtime/worker/project-root';
import { describe, expect, it } from 'vitest';

describe('resolveWorkerProjectRoot', () => {
  it('prefers project root from environment over cwd', () => {
    expect(
      resolveWorkerProjectRoot(
        { GVC0_PROJECT_ROOT: '/tmp/project-root' },
        '/tmp/worktree',
      ),
    ).toBe('/tmp/project-root');
  });

  it('falls back to cwd when project root env is absent', () => {
    expect(resolveWorkerProjectRoot({}, '/tmp/worktree')).toBe('/tmp/worktree');
  });
});
