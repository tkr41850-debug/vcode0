import type { Duplex } from 'node:stream';
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
  private buffer = '';
  private closed = false;
  private messageHandler:
    | ((message: WorkerToOrchestratorMessage) => void)
    | undefined;
  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += chunk.toString();

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      this.messageHandler?.(JSON.parse(line) as WorkerToOrchestratorMessage);
    }
  };

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.input.on('data', this.onData);
  }

  send(message: OrchestratorToWorkerMessage): void {
    if (this.closed) {
      return;
    }

    this.output.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.messageHandler = undefined;
    this.input.off('data', this.onData);
  }
}

export class UnixSocketTransport implements IpcTransport {
  private buffer = '';
  private closed = false;
  private messageHandler:
    | ((message: WorkerToOrchestratorMessage) => void)
    | undefined;
  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += chunk.toString();

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      this.messageHandler?.(JSON.parse(line) as WorkerToOrchestratorMessage);
    }
  };

  constructor(private readonly socket: Duplex) {
    this.socket.on('data', this.onData);
  }

  send(message: OrchestratorToWorkerMessage): void {
    if (this.closed) {
      return;
    }

    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.messageHandler = undefined;
    this.socket.off('data', this.onData);
    this.socket.destroy();
  }
}
