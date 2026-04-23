import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import {
  OrchestratorToWorkerFrame,
  WorkerToOrchestratorFrame,
} from '@runtime/ipc/frame-schema';
import {
  createQuarantine,
  type Quarantine,
} from '@runtime/ipc/quarantine';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * REQ-EXEC-03: every line on the NDJSON bridge is validated against a
 * typebox schema. JSON parse failures and schema violations are recorded
 * in the quarantine (in-memory ring + fire-and-forget Store row) and the
 * line is dropped; the handler is NEVER invoked with an untyped payload
 * and the transport never throws.
 *
 * Defense-in-depth: both the parent-side transport (validates
 * WorkerToOrchestratorFrame) and the worker-side transport (validates
 * OrchestratorToWorkerFrame) check every frame. A malicious or broken
 * worker cannot take down the orchestrator with a malformed line, and
 * future multi-tenant designs are protected against malicious parent
 * frames by symmetry.
 */

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

type Direction = 'parent_from_child' | 'child_from_parent';

function recordParseFailure(
  quarantine: Quarantine,
  direction: Direction,
  line: string,
  err: unknown,
): void {
  const errMessage = err instanceof Error ? err.message : String(err);
  quarantine.record({
    ts: Date.now(),
    direction,
    raw: line,
    errorMessage: `json_parse: ${errMessage}`,
  });
}

function recordSchemaFailure(
  quarantine: Quarantine,
  direction: Direction,
  line: string,
  schema: TSchema,
  parsed: unknown,
): void {
  const errors = [...Value.Errors(schema, parsed)]
    .slice(0, 3)
    .map((e) => `${e.path || '/'}: ${e.message}`)
    .join('; ');
  quarantine.record({
    ts: Date.now(),
    direction,
    raw: line,
    errorMessage: `schema: ${errors}`,
  });
}

export class NdjsonStdioTransport implements IpcTransport {
  private readonly rl: readline.Interface;
  private readonly writable: Writable;
  private readonly quarantine: Quarantine;

  constructor(
    streams: { stdin: Writable; stdout: Readable },
    opts: { quarantine?: Quarantine } = {},
  ) {
    this.writable = streams.stdin;
    this.rl = readline.createInterface({ input: streams.stdout });
    this.quarantine = opts.quarantine ?? createQuarantine();
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
        recordParseFailure(this.quarantine, 'parent_from_child', line, err);
        return;
      }
      if (!Value.Check(WorkerToOrchestratorFrame, parsed)) {
        recordSchemaFailure(
          this.quarantine,
          'parent_from_child',
          line,
          WorkerToOrchestratorFrame,
          parsed,
        );
        return;
      }
      handler(parsed as WorkerToOrchestratorMessage);
    });
  }

  /** Test-only accessor for the in-memory quarantine ring. */
  quarantineHandle(): Quarantine {
    return this.quarantine;
  }

  close(): void {
    this.rl.close();
    this.writable.end();
  }
}

export class ChildNdjsonStdioTransport implements ChildIpcTransport {
  private readonly rl: readline.Interface;
  private readonly writable: Writable;
  private readonly quarantine: Quarantine;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    opts: { quarantine?: Quarantine } = {},
  ) {
    this.writable = output;
    this.rl = readline.createInterface({ input });
    this.quarantine = opts.quarantine ?? createQuarantine();
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
        recordParseFailure(this.quarantine, 'child_from_parent', line, err);
        return;
      }
      if (!Value.Check(OrchestratorToWorkerFrame, parsed)) {
        recordSchemaFailure(
          this.quarantine,
          'child_from_parent',
          line,
          OrchestratorToWorkerFrame,
          parsed,
        );
        return;
      }
      handler(parsed as OrchestratorToWorkerMessage);
    });
  }

  quarantineHandle(): Quarantine {
    return this.quarantine;
  }

  close(): void {
    this.rl.close();
  }
}
