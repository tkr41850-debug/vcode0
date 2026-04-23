/**
 * Tool-output persistence for the persist-tool-outputs resume strategy.
 *
 * Per `docs/spikes/pi-sdk-resume.md`, pi-sdk's `Agent.continue()` refuses to
 * proceed when the transcript's last message is an assistant. On resume,
 * we need to splice saved tool-result messages after a terminal
 * assistant-with-tool-calls message so the transcript ends on a
 * `toolResult` role.
 *
 * This store caches the raw tool output (content + details + isError) per
 * `toolCallId` so the splice can reconstruct a `ToolResultMessage` without
 * re-executing the tool. Two backends:
 *
 * - in-memory: transient, fast; intended for unit tests and the happy
 *   single-process resume flow.
 * - file-backed: durable; survives worker crashes. One JSON file per
 *   `toolCallId` under `<dir>/<id>.json`.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { ImageContent, TextContent } from '@mariozechner/pi-ai';

/**
 * Persisted tool-output payload. Mirrors the fields of `ToolResultMessage`
 * that the splice step needs to reconstruct the message on resume.
 */
export interface PersistedToolOutput {
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface ToolOutputStore {
  record(output: PersistedToolOutput): void | Promise<void>;
  get(toolCallId: string): PersistedToolOutput | undefined;
  clear(): void | Promise<void>;
}

/** In-memory store. Not durable across process restarts. */
export function createInMemoryToolOutputStore(): ToolOutputStore {
  const map = new Map<string, PersistedToolOutput>();
  return {
    record(output) {
      map.set(output.toolCallId, output);
    },
    get(toolCallId) {
      return map.get(toolCallId);
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * File-backed store. Writes one JSON file per tool-call id. `get` uses a
 * synchronous read because the splice path (on resume) is a one-shot
 * operation, not a hot-path loop.
 */
export function createFileToolOutputStore(dir: string): ToolOutputStore {
  return {
    async record(output) {
      await fsp.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${safeId(output.toolCallId)}.json`);
      const tmpPath = `${filePath}.tmp`;
      await fsp.writeFile(tmpPath, JSON.stringify(output), 'utf-8');
      await fsp.rename(tmpPath, filePath);
    },
    get(toolCallId) {
      try {
        const raw = fs.readFileSync(
          path.join(dir, `${safeId(toolCallId)}.json`),
          'utf-8',
        );
        return JSON.parse(raw) as PersistedToolOutput;
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    },
    async clear() {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: clear should not block.
      }
    },
  };
}

function safeId(id: string): string {
  // Tool call ids from LLM providers are normally alphanumeric + underscore +
  // hyphen. Defensive sanitization keeps the file name safe on all platforms.
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
