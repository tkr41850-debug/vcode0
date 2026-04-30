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
import type { Quarantine } from '@runtime/ipc/quarantine';

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

export interface NdjsonStdioTransportOptions {
  quarantine?: Quarantine;
  agentRunId?: string;
}

export class NdjsonStdioTransport implements IpcTransport {
  private readonly rl: readline.Interface;
  private readonly writable: Writable;
  private readonly quarantine: Quarantine | undefined;
  private readonly agentRunId: string | undefined;

  constructor(
    streams: { stdin: Writable; stdout: Readable },
    options: NdjsonStdioTransportOptions = {},
  ) {
    this.writable = streams.stdin;
    this.rl = readline.createInterface({ input: streams.stdout });
    this.quarantine = options.quarantine;
    this.agentRunId = options.agentRunId;
  }

  send(message: OrchestratorToWorkerMessage): void {
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void {
    this.rl.on('line', (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.quarantineFrame(line, `parse error: ${stringifyError(err)}`);
        return;
      }
      const result = validateWorkerFrame(parsed);
      if (!result.ok) {
        this.quarantineFrame(line, result.error);
        return;
      }
      handler(result.frame);
    });
  }

  close(): void {
    this.rl.close();
    this.writable.end();
  }

  private quarantineFrame(raw: string, errorMessage: string): void {
    if (this.quarantine !== undefined) {
      this.quarantine.record({
        direction: 'worker_to_orchestrator',
        ...(this.agentRunId !== undefined
          ? { agentRunId: this.agentRunId }
          : {}),
        raw,
        errorMessage,
      });
      return;
    }
    process.stderr.write(
      `[ipc] invalid worker frame: ${errorMessage}: ${raw}\n`,
    );
  }
}

export interface ChildNdjsonStdioTransportOptions {
  quarantine?: Quarantine;
  agentRunId?: string;
}

export class ChildNdjsonStdioTransport implements ChildIpcTransport {
  private readonly rl: readline.Interface;
  private readonly writable: Writable;
  private readonly quarantine: Quarantine | undefined;
  private readonly agentRunId: string | undefined;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    options: ChildNdjsonStdioTransportOptions = {},
  ) {
    this.writable = output;
    this.rl = readline.createInterface({ input });
    this.quarantine = options.quarantine;
    this.agentRunId = options.agentRunId;
  }

  send(message: WorkerToOrchestratorMessage): void {
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: OrchestratorToWorkerMessage) => void): void {
    this.rl.on('line', (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.quarantineFrame(line, `parse error: ${stringifyError(err)}`);
        return;
      }
      const result = validateOrchestratorFrame(parsed);
      if (!result.ok) {
        this.quarantineFrame(line, result.error);
        return;
      }
      handler(result.frame);
    });
  }

  close(): void {
    this.rl.close();
  }

  private quarantineFrame(raw: string, errorMessage: string): void {
    if (this.quarantine !== undefined) {
      this.quarantine.record({
        direction: 'orchestrator_to_worker',
        ...(this.agentRunId !== undefined
          ? { agentRunId: this.agentRunId }
          : {}),
        raw,
        errorMessage,
      });
      return;
    }
    process.stderr.write(
      `[ipc] invalid orchestrator frame: ${errorMessage}: ${raw}\n`,
    );
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
