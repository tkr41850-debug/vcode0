import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  FeatureId,
  VerificationSummary,
  VerifyIssue,
} from '@core/types/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { disposeFeatureAndLeftoverTaskWorktrees } from '@orchestrator/worktree-disposal';
import { type SimpleGit, simpleGit } from 'simple-git';

export type IntegrationOutcome =
  | { kind: 'merged'; mainMergeSha: string; branchHeadSha: string }
  | { kind: 'rebase_conflict'; conflictedFiles: string[] }
  | { kind: 'main_moved'; expectedSha: string; actualSha: string }
  | { kind: 'post_rebase_ci_fail'; verification: VerificationSummary }
  | { kind: 'skipped'; reason: string };

export interface IntegrationDeps {
  ports: OrchestratorPorts;
  graph: FeatureGraph;
  features: FeatureLifecycleCoordinator;
  cwd?: string;
  now?: () => number;
  mainBranch?: string;
}

/**
 * Drives a single feature from `collabControl=integrating` to `merged` (on
 * success) or back to `replanning` (on rebase / post-rebase ci_check
 * failure). Writes a singleton marker row before the rebase so a crash
 * between the `update-ref` CAS and the DB update can be reconciled at
 * startup.
 *
 * Runs inline in the scheduler tick; the async-subprocess variant called
 * out in the design is deferred.
 */
export class IntegrationCoordinator {
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly mainBranch: string;
  private readonly mainGit: SimpleGit;

  constructor(private readonly deps: IntegrationDeps) {
    this.cwd = deps.cwd ?? process.cwd();
    this.now = deps.now ?? Date.now;
    this.mainBranch = deps.mainBranch ?? 'main';
    this.mainGit = simpleGit(this.cwd);
  }

  async runIntegration(featureId: FeatureId): Promise<IntegrationOutcome> {
    const feature = this.deps.graph.features.get(featureId);
    if (feature === undefined) {
      return { kind: 'skipped', reason: `feature "${featureId}" not found` };
    }
    if (feature.collabControl !== 'integrating') {
      return {
        kind: 'skipped',
        reason: `feature "${featureId}" not in integrating state`,
      };
    }

    const featureDir = path.resolve(
      this.cwd,
      worktreePath(feature.featureBranch),
    );
    if (!existsSync(featureDir)) {
      return {
        kind: 'skipped',
        reason: `feature worktree "${featureDir}" not found`,
      };
    }
    const featureGit = simpleGit(featureDir);

    const expectedParentSha = (
      await this.mainGit.revparse([this.mainBranch])
    ).trim();
    const preIntegrationSha = (
      await featureGit.revparse([feature.featureBranch])
    ).trim();
    const configSnapshot = JSON.stringify(
      this.deps.ports.config.verification ?? {},
    );
    const startedAt = this.now();

    this.deps.ports.store.writeIntegrationState({
      featureId,
      expectedParentSha,
      featureBranchPreIntegrationSha: preIntegrationSha,
      configSnapshot,
      intent: 'integrate',
      startedAt,
    });

    const rebaseConflicts = await this.runRebase(featureGit);
    if (rebaseConflicts !== undefined) {
      this.deps.ports.store.clearIntegrationState();
      this.deps.features.rerouteToReplan(featureId, [
        {
          source: 'rebase',
          id: `rb-${featureId}-1`,
          severity: 'blocking',
          description: `Rebase onto ${this.mainBranch} conflicted in ${rebaseConflicts.join(', ')}`,
          conflictedFiles: rebaseConflicts,
        },
      ]);
      return { kind: 'rebase_conflict', conflictedFiles: rebaseConflicts };
    }

    // Record the post-rebase tip so the reconciler can match it against
    // `parents[1]` of the merge commit if we crash between merge and DB clear.
    const postRebaseSha = (
      await featureGit.revparse([feature.featureBranch])
    ).trim();
    this.deps.ports.store.writeIntegrationState({
      featureId,
      expectedParentSha,
      featureBranchPreIntegrationSha: preIntegrationSha,
      featureBranchPostRebaseSha: postRebaseSha,
      configSnapshot,
      intent: 'integrate',
      startedAt,
    });

    const verification =
      await this.deps.ports.verification.verifyFeature(feature);
    if (verification.ok === false) {
      this.deps.ports.store.clearIntegrationState();
      const issues = postRebaseCiIssues(featureId, verification);
      this.deps.features.rerouteToReplan(featureId, issues);
      return { kind: 'post_rebase_ci_fail', verification };
    }

    const currentMainSha = (
      await this.mainGit.revparse([this.mainBranch])
    ).trim();
    if (currentMainSha !== expectedParentSha) {
      this.deps.ports.store.clearIntegrationState();
      this.deps.features.rerouteToReplan(featureId, [
        {
          source: 'rebase',
          id: `rb-${featureId}-1`,
          severity: 'blocking',
          description: `Main moved during integration (${expectedParentSha} → ${currentMainSha})`,
          conflictedFiles: [],
        },
      ]);
      return {
        kind: 'main_moved',
        expectedSha: expectedParentSha,
        actualSha: currentMainSha,
      };
    }

    const mergeBase = (
      await this.mainGit.raw([
        'merge-base',
        expectedParentSha,
        feature.featureBranch,
      ])
    ).trim();
    let mergeTreeSha: string;
    try {
      mergeTreeSha = (
        await this.mainGit.raw([
          'merge-tree',
          '--write-tree',
          `--merge-base=${mergeBase}`,
          expectedParentSha,
          postRebaseSha,
        ])
      ).trim();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[integration] merge-tree conflict after clean rebase featureId=${featureId} error=${message}`,
      );
      this.deps.ports.store.clearIntegrationState();
      this.deps.features.rerouteToReplan(featureId, [
        {
          source: 'rebase',
          id: `rb-${featureId}-1`,
          severity: 'blocking',
          description: `merge-tree conflict after clean rebase: ${message}`,
          conflictedFiles: [],
        },
      ]);
      return { kind: 'rebase_conflict', conflictedFiles: [] };
    }

    const mergeMessage = `Merge ${feature.featureBranch} into ${this.mainBranch}\n`;
    const mergeCommitSha = (
      await this.mainGit.raw([
        'commit-tree',
        mergeTreeSha,
        '-p',
        expectedParentSha,
        '-p',
        postRebaseSha,
        '-m',
        mergeMessage,
      ])
    ).trim();

    try {
      await this.mainGit.raw([
        'update-ref',
        `refs/heads/${this.mainBranch}`,
        mergeCommitSha,
        expectedParentSha,
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isLeaseFailure(message)) {
        throw err;
      }
      const observedSha = (
        await this.mainGit.revparse([this.mainBranch])
      ).trim();
      this.deps.ports.store.clearIntegrationState();
      this.deps.features.rerouteToReplan(featureId, [
        {
          source: 'rebase',
          id: `rb-${featureId}-1`,
          severity: 'blocking',
          description: `Main moved during integration (${expectedParentSha} → ${observedSha})`,
          conflictedFiles: [],
        },
      ]);
      return {
        kind: 'main_moved',
        expectedSha: expectedParentSha,
        actualSha: observedSha,
      };
    }

    const mainMergeSha = mergeCommitSha;
    const branchHeadSha = postRebaseSha;

    this.deps.graph.editFeature(featureId, {
      mainMergeSha,
      branchHeadSha,
    });
    this.deps.ports.store.clearIntegrationState();
    this.deps.features.completeIntegration(featureId);
    await disposeFeatureAndLeftoverTaskWorktrees(
      this.deps.ports,
      this.deps.graph,
      featureId,
    );

    return { kind: 'merged', mainMergeSha, branchHeadSha };
  }

  private async runRebase(
    featureGit: SimpleGit,
  ): Promise<string[] | undefined> {
    try {
      await featureGit.rebase([this.mainBranch]);
      return undefined;
    } catch {
      const status = await featureGit.status();
      const conflicted = [...status.conflicted];
      try {
        await featureGit.raw(['rebase', '--abort']);
      } catch {
        // No active rebase to abort.
      }
      return conflicted;
    }
  }
}

function isLeaseFailure(message: string): boolean {
  return message.includes('cannot lock ref');
}

function postRebaseCiIssues(
  featureId: FeatureId,
  verification: VerificationSummary,
): VerifyIssue[] {
  if (verification.issues !== undefined && verification.issues.length > 0) {
    return verification.issues;
  }
  const failed = verification.failedChecks ?? [];
  if (failed.length === 0) {
    return [
      {
        source: 'ci_check',
        id: `ci-${featureId}-post_rebase-1`,
        severity: 'blocking',
        phase: 'post_rebase',
        checkName: 'ci_check',
        command: '',
        description: verification.summary ?? 'post-rebase ci_check failed',
      },
    ];
  }
  return failed.map((name, index) => ({
    source: 'ci_check',
    id: `ci-${featureId}-post_rebase-${index + 1}`,
    severity: 'blocking',
    phase: 'post_rebase',
    checkName: name,
    command: name,
    description: `${name} failed`,
  }));
}

export type { Feature };
