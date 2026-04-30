export type IpcQuarantineDirection =
  | 'worker_to_orchestrator'
  | 'orchestrator_to_worker';

export interface QuarantinedFrameEntry {
  ts: number;
  direction: IpcQuarantineDirection;
  agentRunId?: string;
  raw: string;
  errorMessage: string;
}

export interface QuarantinedFrameRecord extends QuarantinedFrameEntry {
  id: number;
}

export interface QuarantinedFrameQuery {
  agentRunId?: string;
  limit?: number;
}
