import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { type ApplicationLifecycle, GvcApplication } from '@app/index';
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
  const ui = new TuiApp();

  let scheduler: SchedulerLoop | undefined;
  const runtime = new LocalWorkerPool(
    new PiSdkHarness(sessionStore, projectRoot),
    Math.max(1, os.availableParallelism()),
    (message) => {
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

  let verification: VerificationPort;
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
    start: async () => {
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

  return new GvcApplication(ports, lifecycle);
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
