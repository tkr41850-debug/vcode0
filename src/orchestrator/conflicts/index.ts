import type { FeatureGraph } from '@core/graph/index';
import type { Feature, FeatureId, Task, TaskId } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

import {
  clearCrossFeatureBlock,
  handleCrossFeatureOverlap,
  releaseCrossFeatureOverlap,
  resumeCrossFeatureTasks,
} from './cross-feature.js';
import { type SquashMergeOutcome, squashMergeTaskIntoFeature } from './git.js';
import {
  handleSameFeatureOverlap,
  reconcileSameFeatureTasks,
} from './same-feature.js';
import type { CrossFeatureReleaseResult, OverlapIncident } from './types.js';

export type { SquashMergeOutcome } from './git.js';
export type { CrossFeatureReleaseResult, OverlapIncident } from './types.js';

export class ConflictCoordinator {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph?: FeatureGraph,
  ) {}

  async handleSameFeatureOverlap(
    feature: Feature,
    incident: OverlapIncident,
    tasks: Task[] = [],
  ): Promise<void> {
    return handleSameFeatureOverlap(
      { ports: this.ports, graph: this.graph },
      feature,
      incident,
      tasks,
    );
  }

  async reconcileSameFeatureTasks(
    featureId: FeatureId,
    dominantTaskId: TaskId,
  ): Promise<void> {
    return reconcileSameFeatureTasks(
      { ports: this.ports, graph: this.graph },
      featureId,
      dominantTaskId,
    );
  }

  async handleCrossFeatureOverlap(
    primary: Feature,
    secondary: Feature,
    tasks: Task[],
    overlapFiles: string[] = [],
  ): Promise<void> {
    return handleCrossFeatureOverlap(
      { ports: this.ports, graph: this.graph },
      primary,
      secondary,
      tasks,
      overlapFiles,
    );
  }

  async releaseCrossFeatureOverlap(
    primaryFeatureId: FeatureId,
  ): Promise<CrossFeatureReleaseResult[]> {
    return releaseCrossFeatureOverlap(
      { ports: this.ports, graph: this.graph },
      primaryFeatureId,
    );
  }

  async resumeCrossFeatureTasks(
    featureId: FeatureId,
  ): Promise<{ kind: 'resumed' } | { kind: 'blocked'; summary: string }> {
    return resumeCrossFeatureTasks(
      { ports: this.ports, graph: this.graph },
      featureId,
    );
  }

  clearCrossFeatureBlock(featureId: FeatureId): void {
    clearCrossFeatureBlock(this.graph, featureId);
  }

  async squashMergeTaskIntoFeature(
    taskBranch: string,
    featureBranch: string,
    featureWorktreePath: string,
    commitMessage: string,
  ): Promise<SquashMergeOutcome> {
    return squashMergeTaskIntoFeature(
      taskBranch,
      featureBranch,
      featureWorktreePath,
      commitMessage,
    );
  }
}
