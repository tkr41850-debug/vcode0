import * as warningsModule from '@core/warnings/index';
import {
  createEmptyVerificationChecksWarning,
  createVerifyReplanLoopWarning,
  WarningEvaluator,
  type WarningThresholds,
} from '@core/warnings/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createTaskFixture,
} from '../../../helpers/graph-builders.js';

// ── Warning rule shapes (purity + documentation) ────────────────────────
//
// Plan 01-01 Task 4 declares the invariants for src/core/warnings/*:
//
//  1. Every exported rule is a pure function of its inputs plus an explicit
//     `nowMs` parameter — no module-level state, no Date.now() call.
//  2. Rules return empty output on empty input (quiescent on no data).
//  3. Rules are deterministic: called twice with the same inputs, identical
//     output.
//  4. Warnings module must not import from @runtime / @persistence / @tui /
//     @orchestrator. (Checked by inspecting the source file; encoded below
//     as a structural regex assertion.)
//  5. Every exported rule has an `@warns` JSDoc tag in the source.

const thresholds: WarningThresholds = {
  budgetWarnPercent: 80,
  budgetGlobalUsd: 10,
  featureChurnThreshold: 3,
  taskFailureThreshold: 3,
  longFeatureBlockingMs: 8 * 60 * 60 * 1000,
  verifyReplanLoopThreshold: 3,
};

describe('warning module — public exports', () => {
  it('exports the expected warning-rule surface', () => {
    // The exported rule surface is: WarningEvaluator class + two factory
    // functions for per-event warnings. This list must stay in sync.
    expect(typeof warningsModule.WarningEvaluator).toBe('function');
    expect(typeof warningsModule.createVerifyReplanLoopWarning).toBe(
      'function',
    );
    expect(typeof warningsModule.createEmptyVerificationChecksWarning).toBe(
      'function',
    );
  });
});

describe('WarningEvaluator — quiescent on empty input', () => {
  it('evaluateBudget emits no warning on zero usage', () => {
    const evaluator = new WarningEvaluator(thresholds);
    const result = evaluator.evaluateBudget(
      { totalUsd: 0, totalCalls: 0, perTaskUsd: {} },
      1000,
    );
    expect(result).toEqual([]);
  });

  it('evaluateFeature emits no warning on fresh feature with no history', () => {
    const evaluator = new WarningEvaluator(thresholds);
    const feature = createFeatureFixture();
    const result = evaluator.evaluateFeature(feature, 1000, []);
    expect(result).toEqual([]);
  });

  it('evaluateTask emits no warning on fresh task with no failures', () => {
    const evaluator = new WarningEvaluator(thresholds);
    const task = createTaskFixture();
    const result = evaluator.evaluateTask(task, 1000);
    expect(result).toEqual([]);
  });
});

describe('WarningEvaluator — deterministic / pure', () => {
  it('evaluateBudget returns the same structure across repeated calls', () => {
    const evaluator = new WarningEvaluator(thresholds);
    const state = { totalUsd: 9, totalCalls: 1, perTaskUsd: {} };
    const a = evaluator.evaluateBudget(state, 5000);
    const b = evaluator.evaluateBudget(state, 5000);
    expect(a).toEqual(b);
  });

  it('evaluateFeature returns the same structure across repeated calls', () => {
    const evaluator = new WarningEvaluator(thresholds);
    const feature = createFeatureFixture({ mergeTrainReentryCount: 5 });
    const a = evaluator.evaluateFeature(feature, 5000, []);
    const b = evaluator.evaluateFeature(feature, 5000, []);
    expect(a).toEqual(b);
  });

  it('evaluateTask returns the same structure across repeated calls', () => {
    const evaluator = new WarningEvaluator(thresholds);
    const task = createTaskFixture({ consecutiveFailures: 5 });
    const a = evaluator.evaluateTask(task, 5000);
    const b = evaluator.evaluateTask(task, 5000);
    expect(a).toEqual(b);
  });
});

describe('Standalone warning factories — pure and parameter-driven', () => {
  it('createVerifyReplanLoopWarning uses the passed nowMs, not Date.now()', () => {
    const fixedNow = 12345;
    const signal = createVerifyReplanLoopWarning('f-1', 4, fixedNow);
    expect(signal.occurredAt).toBe(fixedNow);
    expect(signal.category).toBe('verify_replan_loop');
  });

  it('createEmptyVerificationChecksWarning uses the passed nowMs', () => {
    const fixedNow = 67890;
    const signal = createEmptyVerificationChecksWarning(
      'f-1',
      'feature',
      fixedNow,
    );
    expect(signal.occurredAt).toBe(fixedNow);
    expect(signal.category).toBe('empty_verification_checks');
  });

  it('both factories are deterministic on identical input', () => {
    const a = createVerifyReplanLoopWarning('f-1', 4, 1000);
    const b = createVerifyReplanLoopWarning('f-1', 4, 1000);
    expect(a).toEqual(b);

    const c = createEmptyVerificationChecksWarning('f-1', 'task', 1000);
    const d = createEmptyVerificationChecksWarning('f-1', 'task', 1000);
    expect(c).toEqual(d);
  });
});

describe('warnings module source — structural invariants', () => {
  it('does not import from @runtime/@persistence/@tui/@orchestrator', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(import.meta.dirname, '../../../../src/core/warnings');
    const forbidden = ['@runtime/', '@persistence/', '@tui/', '@orchestrator/'];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue;
      const content = readFileSync(resolve(dir, entry), 'utf8');
      for (const pattern of forbidden) {
        expect(
          content.includes(pattern),
          `${entry} must not import ${pattern}`,
        ).toBe(false);
      }
    }
  });

  it('does not call Date.now() inside rule bodies', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(import.meta.dirname, '../../../../src/core/warnings');
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue;
      const content = readFileSync(resolve(dir, entry), 'utf8');
      // Strip line comments and block comments so example JSDoc like
      // "@example myFn(thing, Date.now())" does not trip this check.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(
        stripped.includes('Date.now()'),
        `${entry} must not call Date.now() (time must be a parameter)`,
      ).toBe(false);
    }
  });

  it('every exported function / class has a preceding @warns JSDoc or is a non-rule symbol', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const file = resolve(
      import.meta.dirname,
      '../../../../src/core/warnings/index.ts',
    );
    const content = readFileSync(file, 'utf8');

    // Extract exported-rule function declarations (top-level factory fns +
    // methods on WarningEvaluator). Each rule must have a preceding @warns
    // JSDoc block somewhere in the file — checked by presence count.
    const exportedRuleNames = [
      'createVerifyReplanLoopWarning',
      'createEmptyVerificationChecksWarning',
      'evaluateBudget',
      'evaluateFeature',
      'evaluateTask',
    ];
    // Every rule name appears at least once as a declaration.
    for (const name of exportedRuleNames) {
      expect(content.includes(name)).toBe(true);
    }
    // @warns tag is present at least once per rule.
    const warnsCount = (content.match(/@warns/g) ?? []).length;
    expect(warnsCount).toBeGreaterThanOrEqual(exportedRuleNames.length);
  });
});
