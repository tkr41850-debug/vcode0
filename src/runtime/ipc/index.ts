import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import {
  validateOrchestratorFrame,
  validateWorkerFrame,
} from '@runtime/ipc/frame-schema';

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
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(`[ipc] failed to parse worker message: ${line}\n`);
        return;
      }
      const result = validateWorkerFrame(parsed);
      if (!result.ok) {
        process.stderr.write(
          `[ipc] invalid frame shape: ${result.error}: ${line}\n`,
        );
        return;
      }
      handler(result.frame);
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(
          `[ipc] failed to parse orchestrator message: ${line}\n`,
        );
        return;
      }
      const result = validateOrchestratorFrame(parsed);
      if (!result.ok) {
        process.stderr.write(
          `[ipc] invalid frame shape: ${result.error}: ${line}\n`,
        );
        return;
      }
      handler(result.frame);
    });
  }

  close(): void {
    this.rl.close();
  }
}
