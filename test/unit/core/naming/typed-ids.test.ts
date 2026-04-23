import {
  asBrandedId,
  isFeatureId,
  isMilestoneId,
  isTaskId,
  makeFeatureId,
  makeMilestoneId,
  makeTaskId,
} from '@core/naming/index';
import type { FeatureId, MilestoneId, TaskId } from '@core/types/index';
import { describe, expect, it } from 'vitest';

describe('typed-ID constructors', () => {
  it('makeMilestoneId("alpha") returns "m-alpha"', () => {
    const id: MilestoneId = makeMilestoneId('alpha');
    expect(id).toBe('m-alpha');
  });

  it('makeFeatureId("auth") returns "f-auth"', () => {
    const id: FeatureId = makeFeatureId('auth');
    expect(id).toBe('f-auth');
  });

  it('makeTaskId("implement-login") returns "t-implement-login"', () => {
    const id: TaskId = makeTaskId('implement-login');
    expect(id).toBe('t-implement-login');
  });

  it('asBrandedId utility prepends prefix to raw slug', () => {
    const mid = asBrandedId<MilestoneId>('m-', 'alpha');
    const fid = asBrandedId<FeatureId>('f-', 'auth');
    const tid = asBrandedId<TaskId>('t-', 'login');
    expect(mid).toBe('m-alpha');
    expect(fid).toBe('f-auth');
    expect(tid).toBe('t-login');
  });
});

describe('typed-ID predicates', () => {
  it('isMilestoneId narrows "m-*" strings', () => {
    const candidate: string = 'm-alpha';
    expect(isMilestoneId(candidate)).toBe(true);
    if (isMilestoneId(candidate)) {
      // Type-narrowing proof: candidate is now MilestoneId.
      const narrowed: MilestoneId = candidate;
      expect(narrowed).toBe('m-alpha');
    }
  });

  it('isFeatureId narrows "f-*" strings', () => {
    const candidate: string = 'f-auth';
    expect(isFeatureId(candidate)).toBe(true);
    if (isFeatureId(candidate)) {
      const narrowed: FeatureId = candidate;
      expect(narrowed).toBe('f-auth');
    }
  });

  it('isTaskId narrows "t-*" strings', () => {
    const candidate: string = 't-login';
    expect(isTaskId(candidate)).toBe(true);
    if (isTaskId(candidate)) {
      const narrowed: TaskId = candidate;
      expect(narrowed).toBe('t-login');
    }
  });

  it('predicates reject wrong-prefix strings', () => {
    expect(isMilestoneId('f-auth')).toBe(false);
    expect(isMilestoneId('t-login')).toBe(false);
    expect(isMilestoneId('alpha')).toBe(false);

    expect(isFeatureId('m-alpha')).toBe(false);
    expect(isFeatureId('t-login')).toBe(false);
    expect(isFeatureId('auth')).toBe(false);

    expect(isTaskId('m-alpha')).toBe(false);
    expect(isTaskId('f-auth')).toBe(false);
    expect(isTaskId('login')).toBe(false);
  });
});

describe('typed-ID compile-time safety', () => {
  it('rejects cross-prefix assignment at compile time (FeatureId → TaskId)', () => {
    const fid = makeFeatureId('x');
    // @ts-expect-error — FeatureId cannot be assigned to TaskId
    const tid: TaskId = fid;
    // Runtime value is still a string; the assertion is purely structural.
    expect(typeof tid).toBe('string');
  });

  it('rejects cross-prefix assignment at compile time (MilestoneId → FeatureId)', () => {
    const mid = makeMilestoneId('alpha');
    // @ts-expect-error — MilestoneId cannot be assigned to FeatureId
    const fid: FeatureId = mid;
    expect(typeof fid).toBe('string');
  });

  it('rejects cross-prefix assignment at compile time (TaskId → MilestoneId)', () => {
    const tid = makeTaskId('login');
    // @ts-expect-error — TaskId cannot be assigned to MilestoneId
    const mid: MilestoneId = tid;
    expect(typeof mid).toBe('string');
  });
});
