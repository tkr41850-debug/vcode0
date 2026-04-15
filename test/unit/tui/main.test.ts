import { beforeEach, describe, expect, it, vi } from 'vitest';

const composeApplication = vi.fn();

vi.mock('@root/compose', () => ({
  composeApplication,
}));

describe('main CLI', () => {
  beforeEach(() => {
    composeApplication.mockReset();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('parses auto mode', async () => {
    const { parseAppMode } = await import('@root/main');

    expect(parseAppMode([])).toBe('interactive');
    expect(parseAppMode(['--auto'])).toBe('auto');
  });

  it('writes startup errors and stops partially started app', async () => {
    const app = {
      start: vi.fn().mockRejectedValue(new Error('tty missing')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    composeApplication.mockResolvedValue(app);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { runCli } = await import('@root/main');
    await runCli([]);

    expect(app.start).toHaveBeenCalledWith('interactive');
    expect(app.stop).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      'Failed to start gvc0 TUI: tty missing\n',
    );
  });

  it('reports stop cleanup failures', async () => {
    const app = {
      start: vi.fn().mockRejectedValue(new Error('tty missing')),
      stop: vi.fn().mockRejectedValue(new Error('stop failed')),
    };
    composeApplication.mockResolvedValue(app);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { runCli } = await import('@root/main');
    await runCli([]);

    expect(stderrSpy).toHaveBeenCalledWith(
      'Failed to start gvc0 TUI: tty missing\n',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      'Failed to stop gvc0 cleanly: stop failed\n',
    );
  });
});
