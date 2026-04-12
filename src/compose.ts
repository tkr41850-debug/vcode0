import type { AgentPort } from '@agents';
import { GvcApplication } from '@app/index';
import { StubAgentPort } from '@app/stub-ports';
import type { GvcConfig } from '@core/types/index';
import { LocalGitPort } from '@git/local-git-port';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SqliteStore } from '@persistence/sqlite';
import { ProcessWorkerPool } from '@runtime/process-worker-pool';
import { TuiApp } from '@tui/app';

const DEFAULT_CONFIG: GvcConfig = {
  tokenProfile: 'balanced',
};

export interface ComposeOptions {
  /** Override the SQLite database path (default: .gvc0/state.db in cwd). */
  dbPath?: string;
  /** Override the orchestrator config (default: balanced token profile). */
  config?: GvcConfig;
  /** Override the UI port (default: TuiApp backed by the real store). */
  ui?: UiPort;
}

/**
 * Build a fully-wired {@link GvcApplication}. During the bootstrap phases
 * several ports are deliberately stubbed and will throw {@link
 * import('@app/errors').NotYetWiredError} when their methods are touched. Each
 * subsequent phase replaces one stub with a real implementation.
 */
export function composeApplication(
  options: ComposeOptions = {},
): GvcApplication {
  const store =
    options.dbPath !== undefined
      ? new SqliteStore(options.dbPath)
      : new SqliteStore();

  const ports: OrchestratorPorts = {
    store,
    git: new LocalGitPort(),
    runtime: new ProcessWorkerPool(),
    // StubAgentPort implements both PlannerAgent and ReplannerAgent surfaces.
    agents: new StubAgentPort() as unknown as AgentPort,
    ui: options.ui ?? new TuiApp({ store }),
    config: options.config ?? DEFAULT_CONFIG,
  };

  return new GvcApplication(ports);
}
