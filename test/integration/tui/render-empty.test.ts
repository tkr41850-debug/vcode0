import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@persistence/sqlite';
import { TuiApp } from '@tui/app';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('TuiApp renders against an empty store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gvc0-tui-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a frame with header, DAG placeholder, and status bar', async () => {
    const store = new SqliteStore(join(tempDir, 'state.db'));
    const frames: string[][] = [];
    const app = new TuiApp({
      store,
      pollIntervalMs: 0,
      writeFrame: (lines) => frames.push(lines),
    });

    const started = app.show();
    // Yield so the initial refreshFromStore promise chain resolves.
    await new Promise((resolve) => setTimeout(resolve, 10));
    app.dispose();
    await started;

    expect(frames.length).toBeGreaterThan(0);
    const frame = frames[frames.length - 1]!;
    const joined = frame.join('\n');

    // Header
    expect(joined).toContain('gvc0');
    // DAG placeholder — not the old literal '[DAG]' sentinel
    expect(joined).not.toContain('[DAG]');
    expect(joined).toContain('DAG');
    expect(joined).toContain('no milestones');
    // Status bar
    expect(joined).toContain('status');
    expect(joined).toContain('done=0/0');
  });
});
