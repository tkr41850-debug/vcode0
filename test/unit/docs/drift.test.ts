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
const DATA_MODEL_DOC = readFileSync('docs/architecture/data-model.md', 'utf8');
const TUI_REFERENCE_DOC = readFileSync('docs/reference/tui.md', 'utf8');
const RUNS_SOURCE = readFileSync('src/core/types/runs.ts', 'utf8');
const DOMAIN_SOURCE = readFileSync('src/core/types/domain.ts', 'utf8');
const VERIFICATION_TYPES_SOURCE = readFileSync(
  'src/core/types/verification.ts',
  'utf8',
);
const TUI_COMMANDS_SOURCE = readFileSync('src/tui/commands/index.ts', 'utf8');
const TUI_APP_SOURCE = readFileSync('src/tui/app.ts', 'utf8');
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

function extractInterfaceBlock(source: string, interfaceName: string): string {
  const match = new RegExp(
    `export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  expect(match, `missing exported interface ${interfaceName}`).not.toBeNull();
  return match?.[1] ?? '';
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

  describe('data model reference', () => {
    it('keeps feature and task field lists aligned with shipped domain types', () => {
      const featureSource = extractInterfaceBlock(DOMAIN_SOURCE, 'Feature');
      const taskSource = extractInterfaceBlock(DOMAIN_SOURCE, 'Task');

      expect(featureSource).toContain('runtimeBlockedByFeatureId?: FeatureId');
      expect(DATA_MODEL_DOC).toContain('runtimeBlockedByFeatureId?: FeatureId');
      expect(featureSource).not.toContain('mainMergeSha');
      expect(featureSource).not.toContain('branchHeadSha');
      expect(taskSource).not.toContain('branchHeadSha');
      expect(DATA_MODEL_DOC).not.toContain('mainMergeSha?: string');
      expect(DATA_MODEL_DOC).not.toContain('branchHeadSha?: string');
    });

    it('documents the shipped flat VerifyIssue shape', () => {
      const verifyIssueSource = extractInterfaceBlock(
        VERIFICATION_TYPES_SOURCE,
        'VerifyIssue',
      );

      for (const field of [
        'id: string',
        'severity: VerifyIssueSeverity',
        'description: string',
        'location?: string',
        'suggestedFix?: string',
      ]) {
        expect(verifyIssueSource).toContain(field);
        expect(DATA_MODEL_DOC).toContain(field);
      }
      for (const staleClaim of [
        "source: 'verify'",
        "source: 'ci_check'",
        "source: 'rebase'",
        "phase: 'feature' | 'post_rebase'",
        'conflictedFiles: string[]',
      ]) {
        expect(DATA_MODEL_DOC).not.toContain(staleClaim);
      }
    });
  });

  describe('TUI reference', () => {
    it('documents shipped CLI entrypoints', () => {
      for (const command of [
        'gvc0',
        'gvc0 --auto',
        'gvc0 --cwd <path>',
        'gvc0 explain feature <id>',
        'gvc0 explain task <id>',
        'gvc0 explain run <id>',
      ]) {
        expect(TUI_REFERENCE_DOC).toContain(command);
      }
    });

    it('keeps documented graph hotkeys aligned with registered commands', () => {
      for (const key of ['i', 't', 'r', 'c']) {
        expect(TUI_COMMANDS_SOURCE).toContain(`key: '${key}'`);
        expect(TUI_REFERENCE_DOC).toContain(`| \`${key}\``);
      }
    });

    it('documents current overlay surfaces', () => {
      for (const overlay of [
        'InboxOverlay',
        'PlannerAuditOverlay',
        'ProposalReviewOverlay',
        'MergeTrainOverlay',
        'ConfigOverlay',
        'PlannerSessionOverlay',
        'TaskTranscriptOverlay',
      ]) {
        expect(TUI_APP_SOURCE).toContain(overlay);
      }
      for (const surface of [
        'inbox overlay',
        'planner audit overlay',
        'proposal review overlay',
        'merge-train overlay',
        'config overlay',
        'planner-session overlay',
        'task transcript overlay',
      ]) {
        expect(TUI_REFERENCE_DOC).toContain(surface);
      }
    });

    it('documents shipped operational slash-command surfaces', () => {
      for (const command of [
        '/inbox',
        '/planner-audit',
        '/proposal-review',
        '/merge-train',
        '/transcript',
        '/config',
        '/inbox-reply',
        '/inbox-approve',
        '/inbox-reject',
        '/config-set',
      ]) {
        expect(TUI_REFERENCE_DOC).toContain(command);
      }
    });
  });
});
