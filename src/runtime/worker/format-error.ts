/**
 * Convert an unknown thrown value into an `error` IPC frame body.
 *
 * `Error.stack` already prefixes the message at its head — return it
 * verbatim so consumers see the canonical V8 trace ("Error: boom\n    at ...").
 */
export function formatError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: 'unknown error' };
  }
}
