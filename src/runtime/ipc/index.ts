import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';

export interface IpcTransport {
  send(message: OrchestratorToWorkerMessage): void;
  onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void;
  close(): void;
}

export class NdjsonStdioTransport implements IpcTransport {
  send(_message: OrchestratorToWorkerMessage): void {}

  onMessage(_handler: (message: WorkerToOrchestratorMessage) => void): void {}

  close(): void {}
}

export class UnixSocketTransport implements IpcTransport {
  send(_message: OrchestratorToWorkerMessage): void {}

  onMessage(_handler: (message: WorkerToOrchestratorMessage) => void): void {}

  close(): void {}
}
