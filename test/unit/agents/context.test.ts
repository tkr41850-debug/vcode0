import {
  buildDiscussContext,
  buildPlanContext,
  buildResearchContext,
  buildSummarizeContext,
  buildVerifyContext,
} from '@agents/context';
import type { Feature, Task } from '@core/types/index';
import { describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

function featureWithPhaseOutputs(overrides: Partial<Feature> = {}): Feature {
  return createFeatureFixture({
    roughDraft: 'draft v1',
    discussOutput: [{ topic: 'scope', decision: 'only email' }],
    researchOutput: [{ topic: 'lib', finding: 'bcrypt-js' }],
    featureObjective: 'ship login',
    featureDoD: ['login works', 'tests green'],
    ...overrides,
  });
}

describe('feature-phase context composers', () => {
  it('buildDiscussContext carries roughDraft only', () => {
    const feature = featureWithPhaseOutputs();
    const ctx = buildDiscussContext(feature);
    expect(ctx.feature).toBe(feature);
    expect(ctx.roughDraft).toBe('draft v1');
    expect(ctx).not.toHaveProperty('discussOutput');
    expect(ctx).not.toHaveProperty('researchOutput');
  });

  it('buildDiscussContext returns a clean partial when roughDraft absent', () => {
    const feature = createFeatureFixture();
    const ctx = buildDiscussContext(feature);
    expect(ctx).toEqual({ feature });
  });

  it('buildResearchContext carries roughDraft + discussOutput', () => {
    const feature = featureWithPhaseOutputs();
    const ctx = buildResearchContext(feature);
    expect(ctx.roughDraft).toBe('draft v1');
    expect(ctx.discussOutput).toEqual([
      { topic: 'scope', decision: 'only email' },
    ]);
    expect(ctx).not.toHaveProperty('researchOutput');
  });

  it('buildPlanContext carries draft + decisions + findings', () => {
    const feature = featureWithPhaseOutputs();
    const ctx = buildPlanContext(feature);
    expect(ctx.roughDraft).toBe('draft v1');
    expect(ctx.discussOutput?.[0]?.decision).toBe('only email');
    expect(ctx.researchOutput?.[0]?.finding).toBe('bcrypt-js');
  });

  it('buildVerifyContext includes objective/DoD and tasks', () => {
    const feature = featureWithPhaseOutputs();
    const tasks: Task[] = [
      createTaskFixture({ id: 't-1', description: 'a' }),
      createTaskFixture({ id: 't-2', description: 'b' }),
    ];
    const ctx = buildVerifyContext(feature, tasks, 'diff here');
    expect(ctx.featureObjective).toBe('ship login');
    expect(ctx.featureDoD).toEqual(['login works', 'tests green']);
    expect(ctx.tasks).toBe(tasks);
    expect(ctx.diff).toBe('diff here');
  });

  it('buildSummarizeContext surfaces prior verify issues when present', () => {
    const feature = featureWithPhaseOutputs({
      verifyIssues: [
        { id: 'vi-1', severity: 'concern', description: 'edge case' },
      ],
    });
    const tasks: Task[] = [createTaskFixture({ id: 't-1', description: 'a' })];
    const ctx = buildSummarizeContext(feature, tasks);
    expect(ctx.featureDoD).toEqual(['login works', 'tests green']);
    expect(ctx.priorVerifyIssues?.[0]?.id).toBe('vi-1');
    expect(ctx).not.toHaveProperty('diff');
  });
});
