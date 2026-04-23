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

// Plan 03-03: escalation item append-shape. `payload` is JSON-serialised to
// the `inbox_items.payload` TEXT column; callers stash any structured
// context (error stack, attempt count, etc.) here. Phase 7 extends the
// schema with resolution tracking + query helpers; this plan only owns
// append.
export interface InboxItemAppend {
  id: string;
  ts: number;
  taskId?: string;
  agentRunId?: string;
  featureId?: string;
  kind: string;
  payload: unknown;
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

  // === Inbox + last-commit SHA (Phase 3, plan 03-03) ===
  // `appendInboxItem` writes a stub `inbox_items` row (migration 0005) for
  // REQ-EXEC-04 semantic-failure escalation. Phase 7 extends this with
  // resolution tracking + richer query helpers.
  // `setLastCommitSha` persists the SHA of the most recent commit produced
  // by a worker run (migration 0006), read by Phase 6 merge-train.
  appendInboxItem(item: InboxItemAppend): void;
  setLastCommitSha(agentRunId: string, sha: string): void;

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
