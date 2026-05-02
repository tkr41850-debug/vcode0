import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const STATE_AXES_DOC = readFileSync('docs/foundations/state-axes.md', 'utf8');
const RUNS_SOURCE = readFileSync('src/core/types/runs.ts', 'utf8');
const COMPOSITE_TEST = readFileSync(
  'test/unit/core/fsm/composite-invariants.test.ts',
  'utf8',
);

function extractStringUnion(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(
    source,
  );
  expect(match, `missing exported union ${typeName}`).not.toBeNull();

  const unionSource = match?.[1] ?? '';

  return Array.from(unionSource.matchAll(/'([^']+)'/g), (literal) => {
    const value = literal[1];
    expect(value).toBeDefined();
    return value as string;
  });
}

describe('documentation drift checks', () => {
  describe('state axes', () => {
    it('documents every shipped agent run status', () => {
      const runStatuses = extractStringUnion(RUNS_SOURCE, 'AgentRunStatus');

      for (const status of runStatuses) {
        expect(STATE_AXES_DOC).toContain(status);
      }
    });

    it('documents checkpointed wait transitions', () => {
      expect(STATE_AXES_DOC).toContain(
        'await_response --> checkpointed_await_response',
      );
      expect(STATE_AXES_DOC).toContain(
        'await_approval --> checkpointed_await_approval',
      );
      expect(STATE_AXES_DOC).toContain('checkpointed_await_response --> ready');
      expect(STATE_AXES_DOC).toContain(
        'checkpointed_await_response --> running',
      );
      expect(STATE_AXES_DOC).toContain('checkpointed_await_approval --> ready');
      expect(STATE_AXES_DOC).toContain(
        'checkpointed_await_approval --> running',
      );
    });

    it('keeps the composite-domain claim aligned with the exhaustive test', () => {
      expect(COMPOSITE_TEST).toContain('10 × 7 × 8 = 560 test cases');
      expect(STATE_AXES_DOC).toContain('10 × 7 × 8 = 560 combinations');
      for (const status of [
        'ready',
        'running',
        'retry_await',
        'await_response',
        'await_approval',
        'checkpointed_await_response',
        'checkpointed_await_approval',
        'completed',
      ]) {
        expect(STATE_AXES_DOC).toContain(status);
      }
      expect(STATE_AXES_DOC).not.toContain('10 × 7 × 6 = 420');
      expect(STATE_AXES_DOC).not.toContain(
        'six non-terminal / terminal-success',
      );
    });
  });
});
