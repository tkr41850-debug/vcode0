import { GvcConfigSchema } from '@config/schema';
import { describe, expect, it } from 'vitest';

const validMinimal = {
  models: {
    topPlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    featurePlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    taskWorker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    verifier: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  },
};

describe('GvcConfigSchema', () => {
  it('accepts valid minimal config and applies defaults', () => {
    const cfg = GvcConfigSchema.parse(validMinimal);
    expect(cfg.dbPath).toBe('.gvc0/state.db');
    expect(cfg.workerCap).toBe(4);
    expect(cfg.retryCap).toBe(5);
    expect(cfg.reentryCap).toBe(10);
    expect(cfg.pauseTimeouts.hotWindowMs).toBe(600_000);
    expect(cfg.budget).toBeUndefined();
    expect(cfg.tokenProfile).toBe('balanced');
  });

  it('applies retry-policy defaults (Plan 03-03)', () => {
    const cfg = GvcConfigSchema.parse(validMinimal);
    expect(cfg.retry.baseDelayMs).toBe(250);
    expect(cfg.retry.maxDelayMs).toBe(30_000);
    expect(cfg.retry.transientErrorPatterns).toContain('ECONNRESET');
    expect(cfg.retry.transientErrorPatterns).toContain('rate limit');
    expect(cfg.retry.transientErrorPatterns).toContain('health_timeout');
  });

  it('honours explicit retry overrides', () => {
    const cfg = GvcConfigSchema.parse({
      ...validMinimal,
      retry: {
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        transientErrorPatterns: ['custom_pattern'],
      },
    });
    expect(cfg.retry.baseDelayMs).toBe(500);
    expect(cfg.retry.maxDelayMs).toBe(10_000);
    expect(cfg.retry.transientErrorPatterns).toEqual(['custom_pattern']);
  });

  it('rejects non-positive retry.maxDelayMs', () => {
    expect(() =>
      GvcConfigSchema.parse({ ...validMinimal, retry: { maxDelayMs: 0 } }),
    ).toThrow();
  });

  it('rejects negative retry.baseDelayMs', () => {
    expect(() =>
      GvcConfigSchema.parse({ ...validMinimal, retry: { baseDelayMs: -1 } }),
    ).toThrow();
  });

  it('applies worktreeRoot default (Plan 03-03)', () => {
    const cfg = GvcConfigSchema.parse(validMinimal);
    expect(cfg.worktreeRoot).toBe('.gvc0/worktrees');
  });

  it('honours explicit worktreeRoot override', () => {
    const cfg = GvcConfigSchema.parse({
      ...validMinimal,
      worktreeRoot: '/tmp/custom-worktrees',
    });
    expect(cfg.worktreeRoot).toBe('/tmp/custom-worktrees');
  });

  it('preserves the per-role model map as authored', () => {
    const cfg = GvcConfigSchema.parse(validMinimal);
    expect(cfg.models.topPlanner.model).toBe('claude-sonnet-4-6');
    expect(cfg.models.taskWorker.provider).toBe('anthropic');
    expect(cfg.models.verifier.model).toBe('claude-haiku-4-5');
  });

  it('rejects missing role mapping (REQ-CONFIG-01)', () => {
    const { taskWorker: _drop, ...incomplete } = validMinimal.models;
    expect(() => GvcConfigSchema.parse({ models: incomplete })).toThrow();
  });

  it('reports the missing-role path in the error', () => {
    const { verifier: _drop, ...incomplete } = validMinimal.models;
    const result = GvcConfigSchema.safeParse({ models: incomplete });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('verifier'))).toBe(true);
    }
  });

  it('rejects empty provider or model string (REQ-CONFIG-01)', () => {
    expect(() =>
      GvcConfigSchema.parse({
        models: {
          ...validMinimal.models,
          verifier: { provider: '', model: 'claude-haiku-4-5' },
        },
      }),
    ).toThrow();
    expect(() =>
      GvcConfigSchema.parse({
        models: {
          ...validMinimal.models,
          taskWorker: { provider: 'anthropic', model: '' },
        },
      }),
    ).toThrow();
  });

  it('rejects non-positive workerCap', () => {
    expect(() =>
      GvcConfigSchema.parse({ ...validMinimal, workerCap: 0 }),
    ).toThrow();
    expect(() =>
      GvcConfigSchema.parse({ ...validMinimal, workerCap: -1 }),
    ).toThrow();
  });

  it('rejects non-positive retryCap and reentryCap', () => {
    expect(() =>
      GvcConfigSchema.parse({ ...validMinimal, retryCap: 0 }),
    ).toThrow();
    expect(() =>
      GvcConfigSchema.parse({ ...validMinimal, reentryCap: -5 }),
    ).toThrow();
  });

  it('rejects non-positive pauseTimeouts.hotWindowMs', () => {
    expect(() =>
      GvcConfigSchema.parse({
        ...validMinimal,
        pauseTimeouts: { hotWindowMs: 0 },
      }),
    ).toThrow();
  });

  it('accepts custom dbPath', () => {
    const cfg = GvcConfigSchema.parse({
      ...validMinimal,
      dbPath: './custom/state.db',
    });
    expect(cfg.dbPath).toBe('./custom/state.db');
  });

  it('accepts budget knobs and applies warnAtPercent default (REQ-CONFIG-02)', () => {
    const cfg = GvcConfigSchema.parse({
      ...validMinimal,
      budget: { globalUsd: 100, perTaskUsd: 5 },
    });
    expect(cfg.budget).toEqual({
      globalUsd: 100,
      perTaskUsd: 5,
      warnAtPercent: 80,
    });
  });

  it('honours explicit budget.warnAtPercent override', () => {
    const cfg = GvcConfigSchema.parse({
      ...validMinimal,
      budget: { globalUsd: 100, perTaskUsd: 5, warnAtPercent: 42 },
    });
    expect(cfg.budget?.warnAtPercent).toBe(42);
  });

  it('rejects budget.warnAtPercent outside 0-100 (REQ-CONFIG-02)', () => {
    expect(() =>
      GvcConfigSchema.parse({
        ...validMinimal,
        budget: { globalUsd: 100, perTaskUsd: 5, warnAtPercent: 150 },
      }),
    ).toThrow();
    expect(() =>
      GvcConfigSchema.parse({
        ...validMinimal,
        budget: { globalUsd: 100, perTaskUsd: 5, warnAtPercent: -5 },
      }),
    ).toThrow();
  });

  it('rejects negative budget.globalUsd / perTaskUsd', () => {
    expect(() =>
      GvcConfigSchema.parse({
        ...validMinimal,
        budget: { globalUsd: -1, perTaskUsd: 5 },
      }),
    ).toThrow();
    expect(() =>
      GvcConfigSchema.parse({
        ...validMinimal,
        budget: { globalUsd: 10, perTaskUsd: -1 },
      }),
    ).toThrow();
  });
});
