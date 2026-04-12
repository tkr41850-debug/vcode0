import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createRunCommandTool } from '@agents/worker/tools/run-command';
import { describe, expect, it } from 'vitest';

import { useTmpDir } from '../../../../helpers/tmp-dir.js';

describe('run_command tool', () => {
  const getTmpDir = useTmpDir('worker-run-command');

  it('captures stdout and exit 0', async () => {
    const tool = createRunCommandTool(getTmpDir());
    const result = await tool.execute('call-1', { command: 'echo hello' });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[exit 0');
    expect(text).toContain('hello');
    expect(result.details.exitCode).toBe(0);
  });

  it('captures stderr and nonzero exit', async () => {
    const tool = createRunCommandTool(getTmpDir());
    const result = await tool.execute('call-1', {
      command: 'echo oops 1>&2; exit 3',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[exit 3');
    expect(text).toContain('oops');
    expect(result.details.exitCode).toBe(3);
  });

  it('runs in the provided working directory', async () => {
    await fs.writeFile(path.join(getTmpDir(), 'marker.txt'), 'here');

    const tool = createRunCommandTool(getTmpDir());
    const result = await tool.execute('call-1', { command: 'ls marker.txt' });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('marker.txt');
  });

  it('reports timeout when the command overruns', async () => {
    const tool = createRunCommandTool(getTmpDir());
    const result = await tool.execute('call-1', {
      command: 'sleep 5',
      timeoutMs: 50,
    });

    expect(result.details.timedOut).toBe(true);
  });
});
