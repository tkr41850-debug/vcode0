import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { FeatureId } from '@core/types/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { type SimpleGit, simpleGit } from 'simple-git';

export type ReconcilerOutcome =
  | { kind: 'idle' }
  | { kind: 'retry'; featureId: FeatureId }
  | {
      kind: 'completed';
      featureId: FeatureId;
      mainMergeSha: string;
      branchHeadSha: string;
    }
  | { kind: 'halted'; featureId: FeatureId; reason: string };

export interface ReconcilerDeps {
  ports: OrchestratorPorts;
  graph: FeatureGraph;
  features: FeatureLifecycleCoordinator;
  cwd?: string;
  mainBranch?: string;
}

/**
 * Treats git refs as authoritative when comparing the in-process state
 * to the persisted integration_state marker on startup.
 *
 * - No marker: nothing to reconcile.
 * - Marker, main SHA == expectedParentSha: merge never ran, clear marker
 *   so the scheduler retries integration on the next tick.
 * - Marker, main is a merge commit whose parents match the marker:
 *   merge ran but the DB tx crashed before clearing it. Finish the
 *   transaction (record SHAs, complete integration, clear marker).
 * - Anything else: halt; leave the marker in place for manual triage.
 */
export class IntegrationReconciler {
  private readonly cwd: string;
  private readonly mainBranch: string;
  private readonly mainGit: SimpleGit;

  constructor(private readonly deps: ReconcilerDeps) {
    this.cwd = deps.cwd ?? process.cwd();
    this.mainBranch = deps.mainBranch ?? 'main';
    this.mainGit = simpleGit(this.cwd);
  }

  async reconcile(): Promise<ReconcilerOutcome> {
    const marker = this.deps.ports.store.getIntegrationState();
    if (marker === undefined) {
      return { kind: 'idle' };
    }

    const {
      featureId,
      expectedParentSha,
      featureBranchPreIntegrationSha,
      featureBranchPostRebaseSha,
    } = marker;
    const expectedMergeParent2 =
      featureBranchPostRebaseSha ?? featureBranchPreIntegrationSha;

    const feature = this.deps.graph.features.get(featureId);
    if (feature === undefined) {
      return {
        kind: 'halted',
        featureId,
        reason: `feature "${featureId}" referenced by marker no longer exists`,
      };
    }

    const currentMainSha = (
      await this.mainGit.revparse([this.mainBranch])
    ).trim();

    if (currentMainSha === expectedParentSha) {
      this.deps.ports.store.clearIntegrationState();
      return { kind: 'retry', featureId };
    }

    const parents = await this.parentsOf(currentMainSha);
    if (
      parents.length === 2 &&
      parents[0] === expectedParentSha &&
      parents[1] === expectedMergeParent2
    ) {
      const branchHeadSha = await this.featureBranchSha(feature.featureBranch);
      this.deps.graph.editFeature(featureId, {
        mainMergeSha: currentMainSha,
        branchHeadSha: branchHeadSha ?? expectedMergeParent2,
      });
      this.deps.features.completeIntegration(featureId);
      this.deps.ports.store.clearIntegrationState();
      return {
        kind: 'completed',
        featureId,
        mainMergeSha: currentMainSha,
        branchHeadSha: branchHeadSha ?? expectedMergeParent2,
      };
    }

    return {
      kind: 'halted',
      featureId,
      reason: `main at ${currentMainSha} does not match expected parent ${expectedParentSha} and is not a recognized merge commit`,
    };
  }

  private async parentsOf(sha: string): Promise<string[]> {
    const raw = await this.mainGit.raw(['show', '-s', '--format=%P', sha]);
    return raw
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
  }

  private async featureBranchSha(branch: string): Promise<string | undefined> {
    const featureDir = path.resolve(this.cwd, worktreePath(branch));
    if (!existsSync(featureDir)) {
      try {
        return (await this.mainGit.revparse([branch])).trim();
      } catch {
        return undefined;
      }
    }
    try {
      return (await simpleGit(featureDir).revparse([branch])).trim();
    } catch {
      return undefined;
    }
  }
}
