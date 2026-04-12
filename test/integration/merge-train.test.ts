import { GraphValidationError } from '@core/graph/index';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MergeTrainScenario } from './harness/merge-train-scenario.js';
import { createMergeTrainScenario } from './harness/merge-train-scenario.js';

describe('merge train integration (persistent graph)', () => {
  let scenario: MergeTrainScenario;

  beforeEach(() => {
    scenario = createMergeTrainScenario();
  });

  afterEach(() => {
    scenario.close();
  });

  describe('serialization and ordering', () => {
    it('only one feature may be integrating at a time', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      coord.beginIntegration('f-a', graph);

      expect(() => coord.beginIntegration('f-b', graph)).toThrow(
        GraphValidationError,
      );
      expect(graph.features.get('f-b')?.collabControl).toBe('merge_queued');
    });

    it('respects feature dependency legality before allowing enqueue', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b', dependsOn: ['f-a'] });

      // B cannot enqueue while A is unmerged — the coordinator rejects it.
      expect(() => coord.enqueueFeatureMerge('f-b', graph)).toThrow(
        /not merged/,
      );

      // Once A reaches merged, B becomes eligible.
      coord.enqueueFeatureMerge('f-a', graph);
      coord.beginIntegration('f-a', graph);
      coord.completeIntegration('f-a', graph);

      coord.enqueueFeatureMerge('f-b', graph);
      expect(graph.features.get('f-b')?.collabControl).toBe('merge_queued');
    });

    it('stays serialized after dependencies are satisfied', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      // FIFO when no manual position and no re-entries: f-a first.
      expect(coord.nextToIntegrate(graph)).toBe('f-a');

      coord.beginIntegration('f-a', graph);
      expect(graph.features.get('f-b')?.collabControl).toBe('merge_queued');
    });

    it('finishes integration before the next feature begins', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      coord.beginIntegration('f-a', graph);
      coord.completeIntegration('f-a', graph);

      expect(graph.features.get('f-a')?.collabControl).toBe('merged');
      expect(coord.nextToIntegrate(graph)).toBe('f-b');

      coord.beginIntegration('f-b', graph);
      expect(graph.features.get('f-b')?.collabControl).toBe('integrating');
    });
  });

  describe('ejection and repair re-entry', () => {
    it('ejects a queued feature back to branch_open for repair', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.ejectFromQueue('f-a', graph);

      const ejected = graph.features.get('f-a');
      expect(ejected?.collabControl).toBe('branch_open');
      expect(ejected?.workControl).toBe('awaiting_merge');
      expect(ejected?.mergeTrainEntrySeq).toBeUndefined();
      expect(ejected?.mergeTrainEnteredAt).toBeUndefined();
      expect(ejected?.mergeTrainReentryCount).toBe(1);
    });

    it('eviction increments reentry count which biases the next sort', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-b' });

      // Both enqueue, f-a first.
      coord.enqueueFeatureMerge('f-a', graph);
      coord.enqueueFeatureMerge('f-b', graph);

      // f-a fails merge-train verification, gets ejected.
      coord.ejectFromQueue('f-a', graph);

      // Repair lands; f-a re-enters. Its reentry count is 1, so it
      // sorts ahead of f-b even though f-b entered the queue earlier.
      coord.enqueueFeatureMerge('f-a', graph);

      expect(coord.nextToIntegrate(graph)).toBe('f-a');
    });

    it('rebase failure during integration surfaces as a conflict collab state', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.beginIntegration('f-a', graph);

      // Simulate a rebase conflict during integration. The coordinator
      // doesn't drive this transition itself — callers report the failure
      // by transitioning collab to 'conflict'.
      graph.transitionFeature('f-a', { collabControl: 'conflict' });

      expect(graph.features.get('f-a')?.collabControl).toBe('conflict');
      // Feature is no longer in the queue.
      expect(coord.nextToIntegrate(graph)).toBeUndefined();
    });

    it('successful repair returns a conflict feature to the queue', () => {
      const { graph, coord } = scenario;
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });

      coord.enqueueFeatureMerge('f-a', graph);
      coord.beginIntegration('f-a', graph);
      graph.transitionFeature('f-a', { collabControl: 'conflict' });

      // Repair work lands, feature returns to branch_open, then re-enqueues.
      graph.transitionFeature('f-a', { collabControl: 'branch_open' });
      coord.enqueueFeatureMerge('f-a', graph);

      const reEnqueued = graph.features.get('f-a');
      expect(reEnqueued?.collabControl).toBe('merge_queued');
      expect(coord.nextToIntegrate(graph)).toBe('f-a');
    });
  });

  describe('state is persisted', () => {
    it('rehydrates merge-train state from the database', () => {
      scenario.seedFeatureAtAwaitingMerge({ id: 'f-a' });
      scenario.coord.enqueueFeatureMerge('f-a', scenario.graph);
      scenario.coord.beginIntegration('f-a', scenario.graph);

      // Rehydrate a second graph over the same DB to confirm the row
      // state is the source of truth rather than in-memory bookkeeping.
      const rehydrated = new PersistentFeatureGraph(
        scenario.db,
        () => scenario.clock.now,
      );

      const feature = rehydrated.features.get('f-a');
      expect(feature?.collabControl).toBe('integrating');
      expect(feature?.workControl).toBe('awaiting_merge');
      expect(feature?.mergeTrainEntrySeq).toBe(1);
    });
  });
});
