export interface FauxResponse {
  readonly text?: string;
  readonly toolCalls?: readonly unknown[];
}

export function fauxStreamFn(): never {
  throw new Error('Not implemented yet.');
}

export const fauxModel = {
  create(): never {
    throw new Error('Not implemented yet.');
  },
} as const;
