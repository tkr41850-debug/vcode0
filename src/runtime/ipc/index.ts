import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';

export interface IpcTransport {
  send(message: OrchestratorToWorkerMessage): void;
  onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void;
  close(): void;
}

export interface ChildIpcTransport {
  send(message: WorkerToOrchestratorMessage): void;
  onMessage(handler: (message: OrchestratorToWorkerMessage) => void): void;
  close(): void;
}

export class NdjsonStdioTransport implements IpcTransport {
  private readonly rl: readline.Interface;
  private readonly writable: Writable;

  constructor(streams: { stdin: Writable; stdout: Readable }) {
    this.writable = streams.stdin;
    this.rl = readline.createInterface({ input: streams.stdout });
  }

  send(message: OrchestratorToWorkerMessage): void {
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void {
    this.rl.on('line', (line: string) => {
      try {
        handler(JSON.parse(line) as WorkerToOrchestratorMessage);
      } catch {
        process.stderr.write(`[ipc] failed to parse worker message: ${line}\n`);
      }
    });
  }

  close(): void {
    this.rl.close();
    this.writable.end();
  }
}

export class ChildNdjsonStdioTransport implements ChildIpcTransport {
  private readonly rl: readline.Interface;
  private readonly writable: Writable;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
  ) {
    this.writable = output;
    this.rl = readline.createInterface({ input });
  }

  send(message: WorkerToOrchestratorMessage): void {
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: OrchestratorToWorkerMessage) => void): void {
    this.rl.on('line', (line: string) => {
      try {
        handler(JSON.parse(line) as OrchestratorToWorkerMessage);
      } catch {
        process.stderr.write(
          `[ipc] failed to parse orchestrator message: ${line}\n`,
        );
      }
    });
  }

  close(): void {
    this.rl.close();
  }
}
