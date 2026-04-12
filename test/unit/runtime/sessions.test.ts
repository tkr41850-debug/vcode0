import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { FileSessionStore } from '@runtime/sessions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('FileSessionStore', () => {
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join('/tmp', 'session-test-'));
    store = new FileSessionStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('save and load', () => {
    it('round-trips messages through save then load', async () => {
      const messages = [
        { role: 'user' as const, content: 'hello', timestamp: 1000 },
        {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'world' }],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { total: 0.001 },
          },
        },
      ] as AgentMessage[];

      await store.save('session-1', messages);
      const loaded = await store.load('session-1');

      expect(loaded).toEqual(messages);
    });

    it('stores in envelope format with version field', async () => {
      await store.save('session-2', []);

      const raw = await fs.readFile(
        path.join(tmpDir, '.gvc0', 'sessions', 'session-2.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as {
        version: number;
        messages: unknown[];
      };

      expect(parsed.version).toBe(1);
      expect(parsed.messages).toEqual([]);
    });

    it('creates the sessions directory if it does not exist', async () => {
      await store.save('session-3', []);

      const stat = await fs.stat(path.join(tmpDir, '.gvc0', 'sessions'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('overwrites a previous save atomically', async () => {
      const first = [
        { role: 'user' as const, content: 'v1', timestamp: 1 },
      ] as AgentMessage[];
      const second = [
        { role: 'user' as const, content: 'v2', timestamp: 2 },
      ] as AgentMessage[];

      await store.save('session-4', first);
      await store.save('session-4', second);

      const loaded = await store.load('session-4');
      expect(loaded).toEqual(second);
    });

    it('does not leave .tmp files after successful save', async () => {
      await store.save('session-5', []);

      const files = await fs.readdir(path.join(tmpDir, '.gvc0', 'sessions'));
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('load non-existent session', () => {
    it('returns null for a session that was never saved', async () => {
      const result = await store.load('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes a previously saved session', async () => {
      await store.save('session-del', []);
      await store.delete('session-del');

      const result = await store.load('session-del');
      expect(result).toBeNull();
    });

    it('does not throw when deleting a non-existent session', async () => {
      await expect(store.delete('ghost')).resolves.toBeUndefined();
    });
  });
});
