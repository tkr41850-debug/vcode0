import type { GvcConfig, ModelRef } from '@core/types/index';

const TEST_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
};

/**
 * Required-fields stub for tests that only care about a subset of `GvcConfig`.
 * Fills the new REQ-CONFIG-01 per-role map plus worker/retry/pause defaults so
 * tests can still spread their own minimal overrides (e.g. `tokenProfile`).
 */
export function testGvcConfigDefaults(): Pick<
  GvcConfig,
  | 'dbPath'
  | 'models'
  | 'workerCap'
  | 'retryCap'
  | 'reentryCap'
  | 'pauseTimeouts'
> {
  return {
    dbPath: '.gvc0/state.db',
    models: {
      topPlanner: TEST_MODEL,
      featurePlanner: TEST_MODEL,
      taskWorker: TEST_MODEL,
      verifier: TEST_MODEL,
    },
    workerCap: 4,
    retryCap: 5,
    reentryCap: 10,
    pauseTimeouts: { hotWindowMs: 10 * 60 * 1000 },
  };
}
