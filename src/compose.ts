import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { type ApplicationLifecycle, GvcApplication } from '@app/index';
import type { AppMode } from '@core/types/index';
import type {
  OrchestratorPorts,
  VerificationPort,
} from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import {
  RecoveryService,
  VerificationService,
} from '@orchestrator/services/index';
import { openDatabase } from '@persistence/db';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import { SqliteStore } from '@persistence/sqlite-store';
import { JsonConfigLoader } from '@root/config';
import { PiSdkHarness } from '@runtime/harness/index';
import { FileSessionStore } from '@runtime/sessions/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { TuiApp } from '@tui/app';

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

export async function composeApplication(): Promise<GvcApplication> {
  const projectRoot = process.cwd();
  await ensureRuntimeDirs(projectRoot);

  const config = await new JsonConfigLoader().load();
  const db = openDatabase(path.join(projectRoot, '.gvc0', 'state.db'));
  const graph = new PersistentFeatureGraph(db);
  const store = new SqliteStore(db);
  const sessionStore = new FileSessionStore(projectRoot);
  const maxWorkers = Math.max(1, os.availableParallelism());

  let scheduler: SchedulerLoop | undefined;
  let stopApplication: (() => Promise<void>) | undefined;

  const ui = new TuiApp({
    snapshot: () => graph.snapshot(),
    listAgentRuns: () => store.listAgentRuns(),
    getWorkerCounts: () => {
      const idleWorkers = runtime.idleWorkerCount();
      return {
        runningWorkers: Math.max(0, maxWorkers - idleWorkers),
        idleWorkers,
        totalWorkers: maxWorkers,
      };
    },
    isAutoExecutionEnabled: () => scheduler?.isAutoExecutionEnabled() ?? false,
    setAutoExecutionEnabled: (enabled) => {
      return scheduler?.setAutoExecutionEnabled(enabled) ?? enabled;
    },
    toggleAutoExecution: () => {
      const next = !(scheduler?.isAutoExecutionEnabled() ?? false);
      return scheduler?.setAutoExecutionEnabled(next) ?? next;
    },
    toggleMilestoneQueue: (milestoneId) => {
      const milestone = graph
        .snapshot()
        .milestones.find((entry) => entry.id === milestoneId);
      if (milestone?.steeringQueuePosition !== undefined) {
        graph.dequeueMilestone(milestoneId);
        return;
      }
      graph.queueMilestone(milestoneId);
    },
    cancelFeature: (featureId) => {
      graph.cancelFeature(featureId);
    },
    saveFeatureRun: (run) => {
      const existing = store.getAgentRun(run.id);
      if (existing === undefined) {
        store.createAgentRun(run);
        return;
      }
      store.updateAgentRun(run.id, {
        phase: run.phase,
        runStatus: run.runStatus,
        owner: run.owner,
        attention: run.attention,
        restartCount: run.restartCount,
        maxRetries: run.maxRetries,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(run.payloadJson !== undefined
          ? { payloadJson: run.payloadJson }
          : {}),
        ...(run.retryAt !== undefined ? { retryAt: run.retryAt } : {}),
      });
    },
    getFeatureRun: (featureId, phase) => {
      const run = store.getAgentRun(`run-feature:${featureId}:${phase}`);
      return run?.scopeType === 'feature_phase' ? run : undefined;
    },
    enqueueApprovalDecision: (event) => {
      scheduler?.enqueue({
        type: 'feature_phase_approval_decision',
        featureId: event.featureId,
        phase: event.phase,
        decision: event.decision,
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
      });
    },
    rerunFeatureProposal: (event) => {
      scheduler?.enqueue({
        type: 'feature_phase_rerun_requested',
        featureId: event.featureId,
        phase: event.phase,
      });
    },
    quit: async () => {
      await stopApplication?.();
    },
  });

  let verification: VerificationPort;
  const runtime = new LocalWorkerPool(
    new PiSdkHarness(sessionStore, projectRoot),
    maxWorkers,
    (message) => {
      if (message.type === 'progress') {
        ui.onWorkerOutput(message.agentRunId, message.taskId, message.message);
      }
      if (message.type === 'assistant_output') {
        ui.onWorkerOutput(message.agentRunId, message.taskId, message.text);
      }
      scheduler?.enqueue({ type: 'worker_message', message });
    },
  );
  const agents = new PiFeatureAgentRuntime({
    modelId: config.modelRouting?.ceiling ?? DEFAULT_MODEL_ID,
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    getApiKey,
  });

  const ports: OrchestratorPorts = {
    store,
    runtime,
    agents,
    get verification() {
      return verification;
    },
    ui,
    config,
  };

  verification = new VerificationService(ports, projectRoot);
  scheduler = new SchedulerLoop(graph, ports);
  const recovery = new RecoveryService(ports, graph, projectRoot);

  const lifecycle: ApplicationLifecycle = {
    start: async (mode: AppMode) => {
      scheduler?.setAutoExecutionEnabled(mode === 'auto');
      await recovery.recoverOrphanedRuns();
      await scheduler?.run();
    },
    stop: async () => {
      try {
        await scheduler?.stop();
      } finally {
        db.close();
      }
    },
  };

  const app = new GvcApplication(ports, lifecycle);
  stopApplication = () => app.stop();
  return app;
}

async function ensureRuntimeDirs(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, '.gvc0'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, '.gvc0', 'worktrees'), {
    recursive: true,
  });
}

function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'google':
    case 'gemini':
      return process.env.GEMINI_API_KEY;
    default:
      return undefined;
  }
}
