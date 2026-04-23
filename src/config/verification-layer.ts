import type { GvcConfig, VerificationLayerConfig } from '@core/types/index';

export type VerificationLayerName = 'task' | 'feature' | 'mergeTrain';

const EMPTY_TASK_LAYER: VerificationLayerConfig = {
  checks: [],
  timeoutSecs: 60,
  continueOnFail: false,
};

const EMPTY_FEATURE_LAYER: VerificationLayerConfig = {
  checks: [],
  timeoutSecs: 600,
  continueOnFail: false,
};

/**
 * Resolve the verification layer config for a given layer name, applying the
 * documented fallback (mergeTrain → feature → empty defaults).
 *
 * Kept here as a parked alias for pre-existing call-sites in
 * `src/orchestrator/scheduler/warnings.ts`,
 * `src/orchestrator/services/verification-service.ts`, and
 * `src/core/warnings/index.ts`. The underlying `verification` field stays on
 * the Zod schema as an optional alias until a follow-up plan reshapes those
 * subsystems.
 */
export function resolveVerificationLayerConfig(
  config: GvcConfig,
  layer: VerificationLayerName,
): VerificationLayerConfig {
  const verification = config.verification;

  switch (layer) {
    case 'mergeTrain':
      return (
        verification?.mergeTrain ?? verification?.feature ?? EMPTY_FEATURE_LAYER
      );
    case 'feature':
      return verification?.feature ?? EMPTY_FEATURE_LAYER;
    case 'task':
      return verification?.task ?? EMPTY_TASK_LAYER;
  }
}
