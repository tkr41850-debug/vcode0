import { Duplex, PassThrough } from 'node:stream';
import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { NdjsonStdioTransport, UnixSocketTransport } from '@runtime/ipc/index';
import { describe, expect, it } from 'vitest';

class MockSocket extends Duplex {
  readonly writes: string[] = [];

  _read(): void {}

  _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    );
    callback();
  }

  emitIncoming(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'));
  }
}

type NdjsonStdioTransportConstructor = new (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
) => NdjsonStdioTransport;

type UnixSocketTransportConstructor = new (
  socket: Duplex,
) => UnixSocketTransport;

function createOutgoingMessage(): OrchestratorToWorkerMessage {
  return {
    type: 'resume',
    taskId: 't-1',
    agentRunId: 'run-1',
    reason: 'manual',
  };
}

function createIncomingMessage(
  message = 'worker progress',
): WorkerToOrchestratorMessage {
  return {
    type: 'progress',
    taskId: 't-1',
    agentRunId: 'run-1',
    message,
  };
}

function createNdjsonStdioHarness(): {
  input: PassThrough;
  output: PassThrough;
  transport: NdjsonStdioTransport;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const Transport =
    NdjsonStdioTransport as unknown as NdjsonStdioTransportConstructor;

  return {
    input,
    output,
    transport: new Transport(input, output),
  };
}

function createUnixSocketHarness(): {
  socket: MockSocket;
  transport: UnixSocketTransport;
} {
  const socket = new MockSocket();
  const Transport =
    UnixSocketTransport as unknown as UnixSocketTransportConstructor;

  return {
    socket,
    transport: new Transport(socket),
  };
}

describe('NdjsonStdioTransport', () => {
  it('writes outgoing messages as newline-delimited JSON', () => {
    const { output, transport } = createNdjsonStdioHarness();
    const chunks: string[] = [];
    const message = createOutgoingMessage();

    output.on('data', (chunk: Buffer | string) => {
      chunks.push(chunk.toString());
    });

    transport.send(message);

    expect(chunks.join('')).toBe(`${JSON.stringify(message)}\n`);
  });

  it('parses chunked incoming NDJSON messages', () => {
    const { input, transport } = createNdjsonStdioHarness();
    const received: WorkerToOrchestratorMessage[] = [];
    const message = createIncomingMessage();
    const serialized = JSON.stringify(message);

    transport.onMessage((nextMessage) => {
      received.push(nextMessage);
    });

    input.write(serialized.slice(0, 12));
    input.write(`${serialized.slice(12)}\n`);

    expect(received).toEqual([message]);
  });

  it('stops delivering messages after close', () => {
    const { input, transport } = createNdjsonStdioHarness();
    const received: WorkerToOrchestratorMessage[] = [];
    const first = createIncomingMessage('before close');
    const second = createIncomingMessage('after close');

    transport.onMessage((message) => {
      received.push(message);
    });

    input.write(`${JSON.stringify(first)}\n`);
    transport.close();
    input.write(`${JSON.stringify(second)}\n`);

    expect(received).toEqual([first]);
  });
});

describe('UnixSocketTransport', () => {
  it('writes outgoing messages as newline-delimited JSON', () => {
    const { socket, transport } = createUnixSocketHarness();
    const message = createOutgoingMessage();

    transport.send(message);

    expect(socket.writes.join('')).toBe(`${JSON.stringify(message)}\n`);
  });

  it('parses chunked incoming NDJSON messages', () => {
    const { socket, transport } = createUnixSocketHarness();
    const received: WorkerToOrchestratorMessage[] = [];
    const first = createIncomingMessage('first');
    const second = createIncomingMessage('second');
    const serialized = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;

    transport.onMessage((message) => {
      received.push(message);
    });

    socket.emitIncoming(serialized.slice(0, 20));
    socket.emitIncoming(serialized.slice(20));

    expect(received).toEqual([first, second]);
  });

  it('destroys the socket when closed', () => {
    const { socket, transport } = createUnixSocketHarness();

    transport.close();

    expect(socket.destroyed).toBe(true);
  });
});
