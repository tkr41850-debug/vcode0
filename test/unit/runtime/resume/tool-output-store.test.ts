import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createFileToolOutputStore,
  createInMemoryToolOutputStore,
  type PersistedToolOutput,
} from '@runtime/resume/tool-output-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sampleOutput = (
  toolCallId: string,
  overrides: Partial<PersistedToolOutput> = {},
): PersistedToolOutput => ({
  toolCallId,
  toolName: 'run_command',
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 1_700_000_000_000,
  ...overrides,
});

describe('createInMemoryToolOutputStore', () => {
  it('roundtrips record → get', () => {
    const store = createInMemoryToolOutputStore();
    const output = sampleOutput('tc-1', {
      details: { exitCode: 0 },
      content: [{ type: 'text', text: 'hello' }],
    });

    store.record(output);

    expect(store.get('tc-1')).toEqual(output);
  });

  it('returns undefined for unknown ids', () => {
    const store = createInMemoryToolOutputStore();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('clear() wipes all entries', () => {
    const store = createInMemoryToolOutputStore();
    store.record(sampleOutput('tc-1'));
    store.record(sampleOutput('tc-2'));

    store.clear();

    expect(store.get('tc-1')).toBeUndefined();
    expect(store.get('tc-2')).toBeUndefined();
  });

  it('record overwrites previous entry with same id', () => {
    const store = createInMemoryToolOutputStore();
    store.record(sampleOutput('tc-1', { isError: false }));
    store.record(sampleOutput('tc-1', { isError: true }));

    expect(store.get('tc-1')?.isError).toBe(true);
  });
});

describe('createFileToolOutputStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc0-tool-output-store-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('roundtrips record → get across fresh store instances (survives process boundary)', async () => {
    const storeA = createFileToolOutputStore(dir);
    const output = sampleOutput('tc-file-1', {
      details: { exitCode: 0, stdout: 'hi' },
    });
    await storeA.record(output);

    // New instance simulates a fresh process loading the persisted file.
    const storeB = createFileToolOutputStore(dir);
    const loaded = storeB.get('tc-file-1');

    expect(loaded).toEqual(output);
  });

  it('returns undefined for unknown ids', () => {
    const store = createFileToolOutputStore(dir);
    expect(store.get('nope')).toBeUndefined();
  });

  it('clear() removes the backing directory', async () => {
    const store = createFileToolOutputStore(dir);
    await store.record(sampleOutput('tc-clear'));
    expect(store.get('tc-clear')).toBeDefined();

    await store.clear();

    expect(store.get('tc-clear')).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('sanitizes tool-call ids that contain path separators', async () => {
    const store = createFileToolOutputStore(dir);
    const risky = 'tc/../evil';
    const output = sampleOutput(risky);
    await store.record(output);

    const loaded = store.get(risky);
    expect(loaded).toEqual(output);

    // The file name must not contain path separators so the write cannot
    // escape the backing directory. Pure dots are fine — they become
    // literal characters in a single-segment file name.
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const fileName = files[0];
    expect(fileName).toBeDefined();
    expect(fileName).not.toContain('/');
    expect(fileName).not.toContain(path.sep);
    // The sanitizer replaces `/` with `_`, so `tc/../evil` becomes
    // `tc_.._evil.json` — confined to a single directory entry.
    expect(fileName).toBe('tc_.._evil.json');
  });

  it('record uses atomic rename (no .tmp file left behind on success)', async () => {
    const store = createFileToolOutputStore(dir);
    await store.record(sampleOutput('tc-atomic'));

    const files = fs.readdirSync(dir);
    const hasTmp = files.some((f) => f.endsWith('.tmp'));
    expect(hasTmp).toBe(false);
    expect(files).toContain('tc-atomic.json');
  });
});
