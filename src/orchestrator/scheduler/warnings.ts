import type { FeatureGraph } from '@core/graph/index';
import type { FeatureId, GvcConfig } from '@core/types/index';
import {
  createEmptyVerificationChecksWarning,
  createVerifyReplanLoopWarning,
  DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD,
  type WarningEvaluator,
} from '@core/warnings/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  resolveVerificationLayerConfig,
  type VerificationLayerName,
} from '@root/config';

interface SchedulerWarningDeps {
  graph: FeatureGraph;
  warnings: WarningEvaluator;
  store: OrchestratorPorts['store'];
  config: GvcConfig;
}

export function emitWarningSignals(
  { graph, warnings, store, config }: SchedulerWarningDeps,
  emittedWarnings: ReadonlySet<string>,
  now: number,
): { changed: boolean; emittedWarnings: Set<string> } {
  const tasks = [...graph.tasks.values()];
  const activeWarningKeys = new Set<string>();
  let changed = false;

  const verifyReplanLoopThreshold =
    config.warnings?.verifyReplanLoopThreshold ??
    DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD;

  for (const feature of graph.features.values()) {
    const featureWarnings = warnings.evaluateFeature(feature, now, tasks);
    for (const warning of featureWarnings) {
      const warningKey = buildWarningKey(warning.category, warning.entityId);
      activeWarningKeys.add(warningKey);
      if (emittedWarnings.has(warningKey)) {
        continue;
      }

      store.appendEvent({
        eventType: 'warning_emitted',
        entityId: warning.entityId,
        timestamp: warning.occurredAt,
        payload: {
          category: warning.category,
          message: warning.message,
          ...(warning.payload !== undefined ? { extra: warning.payload } : {}),
        },
      });
      changed = true;
    }

    const failedVerifyCount = countVerifyFailuresSinceLastReplan(
      store,
      feature.id,
    );
    if (failedVerifyCount >= verifyReplanLoopThreshold) {
      const loopKey = buildWarningKey('verify_replan_loop', feature.id);
      activeWarningKeys.add(loopKey);
      if (!emittedWarnings.has(loopKey)) {
        const loopWarning = createVerifyReplanLoopWarning(
          feature.id,
          failedVerifyCount,
          now,
        );
        store.appendEvent({
          eventType: 'warning_emitted',
          entityId: loopWarning.entityId,
          timestamp: loopWarning.occurredAt,
          payload: {
            category: loopWarning.category,
            message: loopWarning.message,
            ...(loopWarning.payload !== undefined
              ? { extra: loopWarning.payload }
              : {}),
          },
        });
        changed = true;
      }
    }
  }

  for (const warningKey of emittedWarnings) {
    if (warningKey.startsWith('empty_verification_checks:')) {
      activeWarningKeys.add(warningKey);
    }
  }

  return { changed, emittedWarnings: activeWarningKeys };
}

export function emitEmptyVerificationChecksWarning(
  { store, config }: SchedulerWarningDeps,
  emittedWarnings: ReadonlySet<string>,
  entityId: FeatureId,
  layer: VerificationLayerName,
  now: number,
): Set<string> {
  const checks = resolveVerificationLayerConfig(config, layer).checks;
  if (checks.length > 0) {
    return new Set(emittedWarnings);
  }

  const warningKey = buildWarningKey(
    'empty_verification_checks',
    entityId,
    layer,
  );
  if (emittedWarnings.has(warningKey)) {
    return new Set(emittedWarnings);
  }

  const nextWarnings = new Set(emittedWarnings);
  const alreadyLogged = store
    .listEvents({ eventType: 'warning_emitted', entityId })
    .some((event) => {
      const extra = event.payload?.extra;
      return (
        event.payload?.category === 'empty_verification_checks' &&
        typeof extra === 'object' &&
        extra !== null &&
        'layer' in extra &&
        extra.layer === layer
      );
    });

  nextWarnings.add(warningKey);
  if (alreadyLogged) {
    return nextWarnings;
  }

  const warning = createEmptyVerificationChecksWarning(entityId, layer, now);
  store.appendEvent({
    eventType: 'warning_emitted',
    entityId,
    timestamp: warning.occurredAt,
    payload: {
      category: warning.category,
      message: warning.message,
      ...(warning.payload !== undefined ? { extra: warning.payload } : {}),
    },
  });
  return nextWarnings;
}

export function countVerifyFailuresSinceLastReplan(
  store: OrchestratorPorts['store'],
  featureId: FeatureId,
): number {
  const events = store.listEvents({
    entityId: featureId,
    eventType: 'feature_phase_completed',
  });
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const phase = event?.payload?.phase;
    const extra = event?.payload?.extra;
    const ok =
      extra !== undefined &&
      extra !== null &&
      typeof extra === 'object' &&
      'ok' in extra
        ? (extra as { ok?: unknown }).ok
        : undefined;
    if ((phase === 'replan' || phase === 'plan') && ok !== false) {
      break;
    }
    if (phase !== 'verify') {
      continue;
    }
    if (ok === false) {
      count += 1;
    }
  }
  return count;
}

export function buildWarningKey(
  category: string,
  entityId: string,
  layer?: VerificationLayerName,
): string {
  return layer === undefined
    ? `${category}:${entityId}`
    : `${category}:${entityId}:${layer}`;
}

export function didRetryWindowExpire(
  store: OrchestratorPorts['store'],
  now: number,
): boolean {
  const lowerBound = now - 1000;
  return store.listAgentRuns().some((run) => {
    return (
      run.runStatus === 'retry_await' &&
      run.retryAt !== undefined &&
      run.retryAt <= now &&
      run.retryAt > lowerBound
    );
  });
}

export function uiStateFingerprint(
  graph: FeatureGraph,
  store: OrchestratorPorts['store'],
  autoExecutionEnabled: boolean,
): string {
  return JSON.stringify({
    graph: graph.snapshot(),
    runs: store.listAgentRuns(),
    autoExecutionEnabled,
  });
}
