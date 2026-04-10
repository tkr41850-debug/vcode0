export interface FauxResponse {
  readonly text?: string;
  readonly toolCalls?: readonly unknown[];
}

// Intended future use: deterministic faux-provider stream helpers for
// integration tests that exercise real agent/tool loops without API calls.
export function fauxStreamFn(): never {
  throw new Error('Not implemented yet.');
}

export const fauxModel = {
  create(): never {
    throw new Error('Not implemented yet.');
  },
} as const;
