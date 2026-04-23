import type { PiFeatureAgentRuntime } from '@agents';
import type { FeatureGraph, GraphSnapshot } from '@core/graph/index';
import type { AgentRun, EventRecord, GvcConfig } from '@core/types/index';
import type { VerificationService } from '@orchestrator/services/verification-service';
import type { RuntimePort } from '@runtime';
import type { SessionStore } from '@runtime/sessions/index';
import type { WorktreeProvisioner } from '@runtime/worktree/index';

export interface AgentRunQuery {
  scopeType?: AgentRun['scopeType'];
  scopeId?: AgentRun['scopeId'];
  phase?: AgentRun['phase'];
  runStatus?: AgentRun['runStatus'];
  owner?: AgentRun['owner'];
}

export interface EventQuery {
  eventType?: string;
  entityId?: string;
  since?: number;
  until?: number;
}

export type AgentRunPatch = {
  [Key in keyof Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>]?:
    | Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>[Key]
    | undefined;
};

export interface RehydrateSnapshot {
  graph: GraphSnapshot;
  openRuns: AgentRun[];
  pendingEvents: EventRecord[];
}

export interface QuarantinedFrameEntry {
  ts: number;
  direction: 'parent_from_child' | 'child_from_parent';
  agentRunId?: string;
  raw: string;
  errorMessage: string;
}

export interface Store {
  // IPC quarantine (REQ-EXEC-03) — persistent tail for malformed NDJSON
  // frames. Callers MUST NOT await this in the hot line-parse path; the
  // in-memory ring (src/runtime/ipc/quarantine.ts) is authoritative for
  // debugging and the Store write is fire-and-forget.
  appendQuarantinedFrame(entry: QuarantinedFrameEntry): void;

  // Agent runs
  getAgentRun(id: string): AgentRun | undefined;
  listAgentRuns(query?: AgentRunQuery): AgentRun[];
  createAgentRun(run: AgentRun): void;
  updateAgentRun(runId: string, patch: AgentRunPatch): void;

  // Events
  listEvents(query?: EventQuery): EventRecord[];
  appendEvent(event: EventRecord): void;

  // Graph (owned by the Store so callers never instantiate a
  // PersistentFeatureGraph directly — the Store is the single
  // persistence boundary).
  graph(): FeatureGraph;
  snapshotGraph(): GraphSnapshot;

  // Boot-path rehydration — drives crash-recovery equality invariant
  // exercised by Plan 02-02.
  rehydrate(): RehydrateSnapshot;

  // === PID registry (Phase 3, plan 03-01) ===
  // Backs WorkerPidRegistry (src/runtime/worktree/pid-registry.ts).
  // Column lives on agent_runs (migration 0003); UPDATE on missing run is a
  // no-op by design — a PID write for a run deleted out-of-band should not
  // resurrect it. Phase 9 crash recovery reads via getLiveWorkerPids().
  setWorkerPid(agentRunId: string, pid: number): void;
  clearWorkerPid(agentRunId: string): void;
  getLiveWorkerPids(): Array<{ agentRunId: string; pid: number }>;

  // Lifecycle
  close(): void;
}

export interface UiPort {
  show(): Promise<void>;
  refresh(): void;
  dispose(): void;
}

export interface OrchestratorPorts {
  store: Store;
  runtime: RuntimePort;
  sessionStore: SessionStore;
  agents: PiFeatureAgentRuntime;
  verification: VerificationService;
  worktree: WorktreeProvisioner;
  ui: UiPort;
  config: GvcConfig;
}
