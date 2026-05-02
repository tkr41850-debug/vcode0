import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const STATE_AXES_DOC = readFileSync('docs/foundations/state-axes.md', 'utf8');
const EXECUTION_FLOW_DOC = readFileSync(
  'docs/foundations/execution-flow.md',
  'utf8',
);
const COORDINATION_RULES_DOC = readFileSync(
  'docs/foundations/coordination-rules.md',
  'utf8',
);
const VERIFICATION_DOC = readFileSync(
  'docs/operations/verification-and-recovery.md',
  'utf8',
);
const CONFLICT_COORDINATION_DOC = readFileSync(
  'docs/operations/conflict-coordination.md',
  'utf8',
);
const MAIN_SOURCE = readFileSync('src/main.ts', 'utf8');
const VERIFICATION_LAYER_SOURCE = readFileSync(
  'src/config/verification-layer.ts',
  'utf8',
);
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

  describe('execution flow and coordination', () => {
    it('documents explain as a read-only pre-TUI branch', () => {
      expect(MAIN_SOURCE).toContain(
        'const explainTarget = parseExplainTarget(argv)',
      );
      expect(MAIN_SOURCE.indexOf('parseExplainTarget(argv)')).toBeLessThan(
        MAIN_SOURCE.indexOf('writeStartupNotice()'),
      );
      expect(MAIN_SOURCE.indexOf('parseExplainTarget(argv)')).toBeLessThan(
        MAIN_SOURCE.indexOf('app = await appFactory()'),
      );

      for (const command of [
        'gvc0 explain feature <id>',
        'gvc0 explain task <id>',
        'gvc0 explain run <id>',
      ]) {
        expect(EXECUTION_FLOW_DOC).toContain(command);
      }
      expect(EXECUTION_FLOW_DOC).toContain('before TUI startup');
      expect(EXECUTION_FLOW_DOC).toContain('read-only');
    });

    it('keeps coordination decision-table families and source sections visible', () => {
      for (const family of [
        'Lock',
        'Claim',
        'Suspend',
        'Resume',
        'Rebase',
        'Re-entry',
      ]) {
        expect(COORDINATION_RULES_DOC).toContain(`## ${family}`);
      }
      expect(
        COORDINATION_RULES_DOC.match(/### Source of truth/g)?.length,
      ).toBeGreaterThanOrEqual(6);
      expect(COORDINATION_RULES_DOC).toContain(
        'Feature.runtimeBlockedByFeatureId',
      );
      expect(COORDINATION_RULES_DOC).toContain('blockedByFeatureId');
      expect(COORDINATION_RULES_DOC).toContain('reconstruction and UI display');
      expect(CONFLICT_COORDINATION_DOC).toContain(
        'Feature.runtimeBlockedByFeatureId',
      );
      expect(CONFLICT_COORDINATION_DOC).toContain(
        'feature-level runtime block is the scheduling authority',
      );
    });

    it('documents merge-train verification fallback without contradicting code', () => {
      expect(VERIFICATION_LAYER_SOURCE).toContain("'mergeTrain'");
      expect(VERIFICATION_LAYER_SOURCE).toContain(
        'mergeTrain → feature → empty defaults',
      );
      expect(VERIFICATION_DOC).toContain(
        'mergeTrain -> feature -> empty defaults',
      );
      expect(VERIFICATION_DOC).not.toContain(
        'There is no separate `verification.mergeTrain` layer',
      );
    });
  });
});
