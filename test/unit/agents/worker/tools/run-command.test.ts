import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createRunCommandTool } from '@agents/worker/tools/run-command';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('run_command tool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'worker-run-command-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('captures stdout and exit 0', async () => {
    const tool = createRunCommandTool(tmpDir);
    const result = await tool.execute('call-1', { command: 'echo hello' });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[exit 0');
    expect(text).toContain('hello');
    expect(result.details.exitCode).toBe(0);
  });

  it('captures stderr and nonzero exit', async () => {
    const tool = createRunCommandTool(tmpDir);
    const result = await tool.execute('call-1', {
      command: 'echo oops 1>&2; exit 3',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[exit 3');
    expect(text).toContain('oops');
    expect(result.details.exitCode).toBe(3);
  });

  it('runs in the provided working directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'marker.txt'), 'here');

    const tool = createRunCommandTool(tmpDir);
    const result = await tool.execute('call-1', { command: 'ls marker.txt' });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('marker.txt');
  });

  it('reports timeout when the command overruns', async () => {
    const tool = createRunCommandTool(tmpDir);
    const result = await tool.execute('call-1', {
      command: 'sleep 5',
      timeoutMs: 50,
    });

    expect(result.details.timedOut).toBe(true);
  });
});
