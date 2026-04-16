import { PassThrough } from 'node:stream';
import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import {
  ChildNdjsonStdioTransport,
  NdjsonStdioTransport,
} from '@runtime/ipc/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tick = () => new Promise<void>((r) => process.nextTick(r));

function createStreamPair() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout };
}

describe('NdjsonStdioTransport (orchestrator side)', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let transport: NdjsonStdioTransport;

  beforeEach(() => {
    ({ stdin, stdout } = createStreamPair());
    transport = new NdjsonStdioTransport({ stdin, stdout });
  });

  afterEach(() => {
    transport.close();
    stdin.destroy();
    stdout.destroy();
  });

  describe('send', () => {
    it('serializes a message as a single NDJSON line', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const message: OrchestratorToWorkerMessage = {
        type: 'abort',
        taskId: 't-1',
        agentRunId: 'run-1',
      };

      transport.send(message);

      const written = Buffer.concat(chunks).toString();
      expect(written).toBe(`${JSON.stringify(message)}\n`);
    });

    it('sends multiple messages as separate lines', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      transport.send({
        type: 'abort',
        taskId: 't-1',
        agentRunId: 'run-1',
      });
      transport.send({
        type: 'steer',
        taskId: 't-2',
        agentRunId: 'run-2',
        directive: { kind: 'sync_recommended', timing: 'next_checkpoint' },
      });

      const written = Buffer.concat(chunks).toString();
      const lines = written.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
    });
  });

  describe('onMessage', () => {
    it('parses incoming NDJSON lines into WorkerToOrchestratorMessage', async () => {
      const received: WorkerToOrchestratorMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      const workerMsg: WorkerToOrchestratorMessage = {
        type: 'progress',
        taskId: 't-1',
        agentRunId: 'run-1',
        message: 'working',
      };

      stdout.write(`${JSON.stringify(workerMsg)}\n`);
      await tick();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(workerMsg);
    });

    it('silently handles malformed JSON lines', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      try {
        const received: WorkerToOrchestratorMessage[] = [];
        transport.onMessage((msg) => received.push(msg));

        stdout.write('not valid json\n');
        await tick();

        expect(received).toHaveLength(0);
        expect(stderrSpy).toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe('close', () => {
    it('closes the readline interface and writable', () => {
      transport.close();
      expect(stdin.writableEnded).toBe(true);
    });
  });
});

describe('ChildNdjsonStdioTransport (worker side)', () => {
  let input: PassThrough;
  let output: PassThrough;
  let transport: ChildNdjsonStdioTransport;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    transport = new ChildNdjsonStdioTransport(input, output);
  });

  afterEach(() => {
    transport.close();
    input.destroy();
    output.destroy();
  });

  describe('send', () => {
    it('serializes worker messages as NDJSON lines', () => {
      const chunks: Buffer[] = [];
      output.on('data', (chunk: Buffer) => chunks.push(chunk));

      const msg: WorkerToOrchestratorMessage = {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-1',
        result: { summary: 'done', filesChanged: ['a.ts'] },
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          llmCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          usd: 0.01,
        },
      };

      transport.send(msg);

      const written = Buffer.concat(chunks).toString();
      expect(written).toBe(`${JSON.stringify(msg)}\n`);
    });
  });

  describe('onMessage', () => {
    it('parses incoming orchestrator messages', async () => {
      const received: OrchestratorToWorkerMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      const orchMsg: OrchestratorToWorkerMessage = {
        type: 'suspend',
        taskId: 't-1',
        agentRunId: 'run-1',
        reason: 'same_feature_overlap',
        files: ['src/main.ts'],
      };

      input.write(`${JSON.stringify(orchMsg)}\n`);
      await tick();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(orchMsg);
    });

    it('handles malformed lines without crashing', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      try {
        const received: OrchestratorToWorkerMessage[] = [];
        transport.onMessage((msg) => received.push(msg));

        input.write('{incomplete\n');
        await tick();

        expect(received).toHaveLength(0);
        expect(stderrSpy).toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe('bidirectional flow', () => {
    it('supports concurrent send and receive on the same transport', async () => {
      const received: OrchestratorToWorkerMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      const outputChunks: Buffer[] = [];
      output.on('data', (chunk: Buffer) => outputChunks.push(chunk));

      transport.send({
        type: 'progress',
        taskId: 't-1',
        agentRunId: 'run-1',
        message: 'step 1',
      });

      input.write(
        `${JSON.stringify({ type: 'manual_input', taskId: 't-1', agentRunId: 'run-1', text: 'go' })}\n`,
      );

      await tick();

      expect(outputChunks.length).toBeGreaterThan(0);
      expect(received).toHaveLength(1);
      expect(received[0]).toBeDefined();
      expect(received[0]?.type).toBe('manual_input');
    });
  });
});
