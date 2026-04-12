import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createEditFileTool } from '@agents/worker/tools/edit-file';
import { createListFilesTool } from '@agents/worker/tools/list-files';
import { createReadFileTool } from '@agents/worker/tools/read-file';
import { createSearchFilesTool } from '@agents/worker/tools/search-files';
import { createWriteFileTool } from '@agents/worker/tools/write-file';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('worker file-ops tools', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'worker-file-ops-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('read_file', () => {
    it('reads file contents relative to workdir', async () => {
      await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'world');
      const tool = createReadFileTool(tmpDir);

      const result = await tool.execute('call-1', { path: 'hello.txt' });

      expect(result.content[0]).toEqual({ type: 'text', text: 'world' });
      expect(result.details.path).toBe('hello.txt');
      expect(result.details.bytes).toBe(5);
    });

    it('throws when the file does not exist', async () => {
      const tool = createReadFileTool(tmpDir);
      await expect(
        tool.execute('call-1', { path: 'missing.txt' }),
      ).rejects.toThrow();
    });
  });

  describe('write_file', () => {
    it('creates a new file with content', async () => {
      const tool = createWriteFileTool(tmpDir);

      await tool.execute('call-1', { path: 'out.txt', content: 'hello' });

      const written = await fs.readFile(path.join(tmpDir, 'out.txt'), 'utf-8');
      expect(written).toBe('hello');
    });

    it('creates parent directories', async () => {
      const tool = createWriteFileTool(tmpDir);

      await tool.execute('call-1', {
        path: 'nested/deep/file.txt',
        content: 'x',
      });

      const written = await fs.readFile(
        path.join(tmpDir, 'nested/deep/file.txt'),
        'utf-8',
      );
      expect(written).toBe('x');
    });

    it('overwrites an existing file', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'old');
      const tool = createWriteFileTool(tmpDir);

      await tool.execute('call-1', { path: 'a.txt', content: 'new' });

      const written = await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf-8');
      expect(written).toBe('new');
    });
  });

  describe('edit_file', () => {
    it('applies an ordered list of replacements', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'code.ts'),
        'const a = 1;\nconst b = 2;\n',
      );
      const tool = createEditFileTool(tmpDir);

      await tool.execute('call-1', {
        path: 'code.ts',
        edits: [
          { oldText: 'const a = 1;', newText: 'const a = 10;' },
          { oldText: 'const b = 2;', newText: 'const b = 20;' },
        ],
      });

      const written = await fs.readFile(path.join(tmpDir, 'code.ts'), 'utf-8');
      expect(written).toBe('const a = 10;\nconst b = 20;\n');
    });

    it('throws when oldText is not found', async () => {
      await fs.writeFile(path.join(tmpDir, 'code.ts'), 'hello');
      const tool = createEditFileTool(tmpDir);

      await expect(
        tool.execute('call-1', {
          path: 'code.ts',
          edits: [{ oldText: 'missing', newText: 'x' }],
        }),
      ).rejects.toThrow(/not found/);
    });

    it('throws when oldText matches more than once', async () => {
      await fs.writeFile(path.join(tmpDir, 'dup.ts'), 'foo\nfoo\n');
      const tool = createEditFileTool(tmpDir);

      await expect(
        tool.execute('call-1', {
          path: 'dup.ts',
          edits: [{ oldText: 'foo', newText: 'bar' }],
        }),
      ).rejects.toThrow(/multiple locations/);
    });
  });

  describe('list_files', () => {
    it('lists top-level files and directories', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), '');
      await fs.mkdir(path.join(tmpDir, 'sub'));
      await fs.writeFile(path.join(tmpDir, 'sub', 'b.txt'), '');

      const tool = createListFilesTool(tmpDir);
      const result = await tool.execute('call-1', {});

      const lines = (result.content[0] as { text: string }).text.split('\n');
      expect(lines).toContain('a.txt');
      expect(lines).toContain('sub/');
      expect(lines).not.toContain('sub/b.txt');
    });

    it('recurses when recursive=true', async () => {
      await fs.mkdir(path.join(tmpDir, 'sub'));
      await fs.writeFile(path.join(tmpDir, 'sub', 'b.txt'), '');

      const tool = createListFilesTool(tmpDir);
      const result = await tool.execute('call-1', { recursive: true });

      const lines = (result.content[0] as { text: string }).text.split('\n');
      expect(lines).toContain('sub/b.txt');
    });

    it('skips ignored directories', async () => {
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'x.js'), '');

      const tool = createListFilesTool(tmpDir);
      const result = await tool.execute('call-1', { recursive: true });

      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('node_modules');
    });
  });

  describe('search_files', () => {
    it('finds matching lines with path and line number', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'a.ts'),
        'const foo = 1;\nconst bar = 2;\n',
      );
      await fs.writeFile(path.join(tmpDir, 'b.ts'), 'const foo = 3;\n');

      const tool = createSearchFilesTool(tmpDir);
      const result = await tool.execute('call-1', { pattern: 'foo' });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('a.ts:1:');
      expect(text).toContain('b.ts:1:');
      expect(result.details.matches).toBe(2);
    });

    it('truncates at maxResults', async () => {
      await fs.writeFile(path.join(tmpDir, 'big.txt'), 'x\nx\nx\nx\nx\n');

      const tool = createSearchFilesTool(tmpDir);
      const result = await tool.execute('call-1', {
        pattern: 'x',
        maxResults: 2,
      });

      expect(result.details.matches).toBe(2);
      expect(result.details.truncated).toBe(true);
    });

    it('rejects invalid regex', async () => {
      const tool = createSearchFilesTool(tmpDir);
      await expect(
        tool.execute('call-1', { pattern: '[unclosed' }),
      ).rejects.toThrow(/invalid regex/);
    });
  });
});
