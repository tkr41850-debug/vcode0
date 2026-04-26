import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { FileSessionStore, type SessionCheckpoint } from '@runtime/sessions';
import { beforeEach, describe, expect, it } from 'vitest';

import { useTmpDir } from '../../helpers/tmp-dir.js';

describe('FileSessionStore', () => {
  const getTmpDir = useTmpDir('session-test');
  let store: FileSessionStore;
  const helpCheckpoint: SessionCheckpoint = {
    messages: [],
    pendingWait: {
      kind: 'help',
      toolCallId: 'tool-help-1',
      query: 'Need guidance',
    },
  };

  beforeEach(() => {
    store = new FileSessionStore(getTmpDir());
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
        path.join(getTmpDir(), '.gvc0', 'sessions', 'session-2.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as {
        version: number;
      };

      expect(parsed.version).toBe(1);
    });

    it('creates the sessions directory if it does not exist', async () => {
      await store.save('session-3', []);

      const stat = await fs.stat(path.join(getTmpDir(), '.gvc0', 'sessions'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('round-trips a wait-state checkpoint through saveCheckpoint then loadCheckpoint', async () => {
      await store.saveCheckpoint('session-checkpoint', helpCheckpoint);

      const loaded = await store.loadCheckpoint('session-checkpoint');

      expect(loaded).toEqual(helpCheckpoint);
    });

    it('round-trips completed tool results and terminal result through checkpoints', async () => {
      const checkpoint: SessionCheckpoint = {
        messages: [],
        completedToolResults: [
          {
            role: 'toolResult',
            toolCallId: 'tool-help-1',
            toolName: 'request_help',
            content: [{ type: 'text', text: 'use option B' }],
            details: { query: 'Need guidance', responseKind: 'answer' },
            isError: false,
            timestamp: 123,
          },
        ],
        terminalResult: {
          summary: 'done',
          filesChanged: ['src/a.ts'],
        },
      };

      await store.saveCheckpoint('session-tool-result', checkpoint);

      const loaded = await store.loadCheckpoint('session-tool-result');

      expect(loaded).toEqual(checkpoint);
    });

    it('load() still returns only messages from a checkpoint save', async () => {
      await store.saveCheckpoint('session-checkpoint-messages', helpCheckpoint);

      const loaded = await store.load('session-checkpoint-messages');

      expect(loaded).toEqual(helpCheckpoint.messages);
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

      const files = await fs.readdir(
        path.join(getTmpDir(), '.gvc0', 'sessions'),
      );
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
    it('deletes checkpoints saved with saveCheckpoint', async () => {
      await store.saveCheckpoint('session-checkpoint-delete', helpCheckpoint);
      await store.delete('session-checkpoint-delete');

      await expect(
        store.loadCheckpoint('session-checkpoint-delete'),
      ).resolves.toBeNull();
    });

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
