import { buildTaskPayload } from '@runtime/context';
import { ModelRouter } from '@runtime/routing';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

describe('buildTaskPayload', () => {
  it('threads planner-baked task fields into payload', () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      description: 'Implement login',
      objective: 'Ship credential flow',
      scope: 'auth middleware only',
      expectedFiles: ['src/auth/login.ts'],
      references: ['docs/auth.md'],
      outcomeVerification: 'login test green',
    });

    const payload = buildTaskPayload(task, undefined);

    expect(payload).toEqual({
      objective: 'Ship credential flow',
      scope: 'auth middleware only',
      expectedFiles: ['src/auth/login.ts'],
      references: ['docs/auth.md'],
      outcomeVerification: 'login test green',
    });
  });

  it('threads feature objective and DoD when feature is provided', () => {
    const feature = createFeatureFixture({
      id: 'f-1',
      name: 'Auth',
      featureObjective: 'Authenticated users only',
      featureDoD: ['all routes guarded', 'passes e2e login test'],
    });
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      description: 'part of auth',
    });

    const payload = buildTaskPayload(task, feature);

    expect(payload.featureObjective).toBe('Authenticated users only');
    expect(payload.featureDoD).toEqual([
      'all routes guarded',
      'passes e2e login test',
    ]);
  });

  it('includes plan summary and dependency outputs from extras', () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      description: 'task',
    });

    const payload = buildTaskPayload(task, undefined, {
      planSummary: 'Phase 1: plumbing',
      dependencyOutputs: [
        {
          taskId: 't-0',
          featureName: 'auth',
          summary: 'setup done',
          filesChanged: ['src/auth/setup.ts'],
        },
      ],
    });

    expect(payload.planSummary).toBe('Phase 1: plumbing');
    expect(payload.dependencyOutputs).toHaveLength(1);
  });

  it('omits absent optional fields', () => {
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      description: 'task',
    });

    const payload = buildTaskPayload(task, undefined);

    expect(payload).toEqual({});
  });

  it('routes models with budget pressure and failure escalation policy', () => {
    const router = new ModelRouter();
    const config = {
      enabled: true,
      ceiling: 'claude-opus-4-6',
      tiers: {
        heavy: 'claude-opus-4-6',
        standard: 'claude-sonnet-4-6',
        light: 'claude-haiku-4-5',
      },
      escalateOnFailure: true,
      budgetPressure: true,
    } as const;

    expect(router.routeModel('standard', config).model).toBe(
      'claude-sonnet-4-6',
    );
    expect(router.routeModel('light', config, { failures: 1 }).tier).toBe(
      'standard',
    );
    expect(
      router.routeModel('heavy', config, { budgetWarned: true }).tier,
    ).toBe('light');
  });
});
