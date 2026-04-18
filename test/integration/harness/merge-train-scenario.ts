import { MergeTrainCoordinator } from '@core/merge-train/index';
import type { FeatureId, MilestoneId } from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import type Database from 'better-sqlite3';

export interface MergeTrainScenario {
  db: Database.Database;
  graph: PersistentFeatureGraph;
  coord: MergeTrainCoordinator;
  /** Mutable clock used for PersistentFeatureGraph row timestamps. */
  clock: { now: number };
  /** Create a milestone once so features have a parent. */
  seedMilestone(id?: MilestoneId): void;
  /**
   * Create a feature and walk its FSM from the initial state to
   * `awaiting_merge / pending / branch_open`, i.e. the entry state
   * expected by `MergeTrainCoordinator.enqueueFeatureMerge`.
   *
   * Uses the real FeatureGraph transitions so every hop is FSM-legal
   * and every row is persisted, matching what a normal run would look
   * like at the moment a feature is ready to merge.
   */
  seedFeatureAtAwaitingMerge(opts: {
    id: FeatureId;
    name?: string;
    dependsOn?: FeatureId[];
  }): void;
  /**
   * Mark a feature as fully merged so downstream features can enqueue.
   * Used to set up dependency features that should appear already-merged.
   */
  markMerged(id: FeatureId): void;
  /** Dispose the underlying database. */
  close(): void;
}

/**
 * Build a fresh in-memory merge-train scenario. The returned bundle owns
 * an isolated SQLite database, a `PersistentFeatureGraph` rehydrated from
 * it, and a `MergeTrainCoordinator`.
 */
export function createMergeTrainScenario(
  initialClock = 1_000_000,
): MergeTrainScenario {
  const clock = { now: initialClock };
  const db = openDatabase(':memory:');
  const graph = new PersistentFeatureGraph(db, () => clock.now);
  const coord = new MergeTrainCoordinator();

  let milestoneSeeded = false;

  const seedMilestone = (id: MilestoneId = 'm-1'): void => {
    graph.createMilestone({ id, name: id, description: '' });
    milestoneSeeded = true;
  };

  const seedFeatureAtAwaitingMerge = (opts: {
    id: FeatureId;
    name?: string;
    dependsOn?: FeatureId[];
  }): void => {
    if (!milestoneSeeded) {
      seedMilestone();
    }

    graph.createFeature({
      id: opts.id,
      milestoneId: 'm-1',
      name: opts.name ?? opts.id,
      description: '',
      ...(opts.dependsOn !== undefined ? { dependsOn: opts.dependsOn } : {}),
    });

    // Walk the happy-path phase ladder. Each in-phase step goes
    // pending → in_progress → done, then advances to the next phase
    // which resets status to pending. Execution entry also opens branch.
    const phases = [
      'discussing',
      'researching',
      'planning',
      'executing',
      'feature_ci',
      'verifying',
      'awaiting_merge',
    ] as const;

    for (const next of phases.slice(1)) {
      graph.transitionFeature(opts.id, { status: 'in_progress' });
      graph.transitionFeature(opts.id, { status: 'done' });
      graph.transitionFeature(opts.id, {
        workControl: next,
        status: 'pending',
        ...(next === 'executing' ? { collabControl: 'branch_open' } : {}),
      });
    }
  };

  const markMerged = (id: FeatureId): void => {
    // Dep features need to look fully integrated so downstream
    // enqueue calls can validate against `collabControl === 'merged'`.
    graph.transitionFeature(id, { collabControl: 'merge_queued' });
    graph.transitionFeature(id, { collabControl: 'integrating' });
    graph.transitionFeature(id, { collabControl: 'merged' });
    graph.updateMergeTrainState(id, {
      mergeTrainManualPosition: undefined,
      mergeTrainEnteredAt: undefined,
      mergeTrainEntrySeq: undefined,
      mergeTrainReentryCount: undefined,
    });
  };

  return {
    db,
    graph,
    coord,
    clock,
    seedMilestone,
    seedFeatureAtAwaitingMerge,
    markMerged,
    close: () => db.close(),
  };
}
