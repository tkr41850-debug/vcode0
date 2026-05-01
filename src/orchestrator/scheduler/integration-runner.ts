import * as path from 'node:path';
import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { Feature } from '@core/types/index';
import { rebaseGitDir } from '@orchestrator/conflicts/git.js';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { simpleGit } from 'simple-git';

import type { SchedulerEvent } from './events.js';

export async function runIntegrationIfPending(params: {
  graph: FeatureGraph;
  ports: OrchestratorPorts;
  handleEvent: (event: SchedulerEvent) => Promise<void>;
  now: number;
  cwd?: string;
}): Promise<void> {
  // 1. Find integrating feature — only one can be integrating at a time.
  let feature: Feature | undefined;
  for (const f of params.graph.features.values()) {
    if (f.collabControl === 'integrating') {
      feature = f;
      break;
    }
  }
  if (feature === undefined) {
    return;
  }

  const cwd = params.cwd ?? process.cwd();
  const featureDir = path.resolve(cwd, worktreePath(feature.featureBranch));

  // 2. Rebase onto main.
  const rebase = await rebaseGitDir(featureDir, 'main');
  if (rebase.kind !== 'clean') {
    const error =
      rebase.kind === 'blocked'
        ? 'worktree missing during integration rebase'
        : `rebase conflict: ${rebase.conflictedFiles.join(', ')}`;
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error,
    });
    return;
  }

  // 3. Shell verification.
  const shellResult = await params.ports.verification.verifyFeature(feature);
  if (!shellResult.ok) {
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error: shellResult.summary ?? 'merge-train shell verification failed',
    });
    return;
  }

  // 4. Agent review (REQ-MERGE-04). Run ID prefix distinguishes from
  //    feature-phase verify runs (run-feature:${id}:verify).
  const run = { agentRunId: `run-integration:${feature.id}` };
  const agentResult = await params.ports.agents.verifyFeature(feature, run);
  if (!agentResult.ok) {
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error: agentResult.summary ?? 'merge-train agent review failed',
    });
    return;
  }

  // 5. Fast-forward merge onto main (only reached after all checks pass).
  try {
    const mainRepo = simpleGit(cwd);
    await mainRepo.merge([feature.featureBranch, '--ff-only']);
  } catch (err) {
    await params.handleEvent({
      type: 'feature_integration_failed',
      featureId: feature.id,
      error: `fast-forward merge failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // 6. Emit complete — main has advanced.
  await params.handleEvent({
    type: 'feature_integration_complete',
    featureId: feature.id,
  });
}
