import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GvcApplication } from '@app/index';
import { StubUiPort } from '@app/stub-ports';
import { composeApplication } from '@root/compose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('composeApplication() bootstrap', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'gvc0-bootstrap-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a GvcApplication wired with all ports', () => {
    const app = composeApplication({ ui: new StubUiPort() });
    expect(app).toBeInstanceOf(GvcApplication);
  });

  it('accepts an explicit dbPath override', () => {
    const dbPath = join(tempDir, 'custom', 'state.db');
    const app = composeApplication({ dbPath });
    expect(app).toBeInstanceOf(GvcApplication);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('app.start() then app.stop() completes cleanly without spawning real work', async () => {
    const app = composeApplication({ ui: new StubUiPort() });

    // start() launches the StubUiPort which blocks on show(); stop() resolves it.
    const started = app.start();

    // Give the event loop a tick so show() registers its resolver.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await app.stop();
    await started;

    // SqliteStore created the on-disk database in the temp cwd.
    expect(existsSync(join(tempDir, '.gvc0', 'state.db'))).toBe(true);
  });

  it('wires LocalGitPort (git.mergeFeatureBranch is no longer stubbed)', () => {
    const app = composeApplication({ ui: new StubUiPort() });
    const ports = (
      app as unknown as {
        ports: { git: { constructor: { name: string } } };
      }
    ).ports;
    expect(ports.git.constructor.name).toBe('LocalGitPort');
  });

  it('wires ProcessWorkerPool as the runtime port', () => {
    const app = composeApplication({ ui: new StubUiPort() });
    const ports = (
      app as unknown as {
        ports: { runtime: { constructor: { name: string } } };
      }
    ).ports;
    expect(ports.runtime.constructor.name).toBe('ProcessWorkerPool');
  });
});
