import { formatError } from '@runtime/worker/format-error';
import { describe, expect, it } from 'vitest';

describe('formatError', () => {
  it('returns Error.stack verbatim — including the leading "Error: <msg>" head', () => {
    const err = new Error('boom');
    const result = formatError(err);
    expect(result.message).toBe('boom');
    expect(result.stack).toBeDefined();
    expect(result.stack).toMatch(/^Error: boom\n\s+at /);
  });

  it('omits stack when Error has no stack', () => {
    const err = new Error('headless');
    Object.defineProperty(err, 'stack', { value: undefined });
    const result = formatError(err);
    expect(result).toEqual({ message: 'headless' });
    expect(result.stack).toBeUndefined();
  });

  it('handles string throws (no stack)', () => {
    const result = formatError('plain string');
    expect(result).toEqual({ message: 'plain string' });
  });

  it('serialises object throws via JSON', () => {
    const result = formatError({ kind: 'weird', n: 1 });
    expect(result).toEqual({ message: '{"kind":"weird","n":1}' });
  });

  it('falls back to "unknown error" when JSON.stringify throws (e.g. cyclic)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = formatError(cyclic);
    expect(result).toEqual({ message: 'unknown error' });
  });

  it('preserves stack identity for subclassed errors', () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'CustomError';
      }
    }
    const err = new CustomError('blew up');
    const result = formatError(err);
    expect(result.message).toBe('blew up');
    expect(result.stack).toContain('blew up');
  });
});
