import { beforeEach, describe, expect, it, vi } from 'vitest';

const composeApplication = vi.fn();

vi.mock('@root/compose', () => ({
  composeApplication,
}));

describe('main CLI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    composeApplication.mockReset();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.exitCode = undefined;
  });

  it('parses auto mode', async () => {
    const { parseAppMode } = await import('@root/main');

    expect(parseAppMode([])).toBe('interactive');
    expect(parseAppMode(['--auto'])).toBe('auto');
  });

  it('writes startup notice before app start', async () => {
    const callOrder: string[] = [];
    const app = {
      start: vi.fn().mockImplementation(() => {
        callOrder.push('start');
        return Promise.resolve();
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    composeApplication.mockResolvedValue(app);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      if (chunk === 'loading...\n') {
        callOrder.push('notice');
      }
      return true;
    }) as typeof process.stdout.write);

    const { runCli } = await import('@root/main');
    await runCli([]);

    expect(stdoutSpy).toHaveBeenCalledWith('loading...\n');
    expect(app.start).toHaveBeenCalledWith('interactive');
    expect(callOrder).toEqual(['notice', 'start']);
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

  it('applies --cwd before startup', async () => {
    const app = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    composeApplication.mockResolvedValue(app);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {});

    const { runCli } = await import('@root/main');
    await runCli(['--cwd', '/tmp/tui-e2e']);

    expect(chdirSpy).toHaveBeenCalledWith('/tmp/tui-e2e');
    expect(app.start).toHaveBeenCalledWith('interactive');
  });

  it('detects tsx direct execution as main', async () => {
    const { isExecutedAsMain } = await import('@root/main');

    expect(isExecutedAsMain('file:///tmp/example.ts', '/tmp/example.ts')).toBe(
      true,
    );
    expect(isExecutedAsMain('file:///tmp/example.ts', '/tmp/other.ts')).toBe(
      false,
    );
    expect(isExecutedAsMain('file:///tmp/example.ts', undefined)).toBe(false);
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
