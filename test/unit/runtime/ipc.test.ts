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

    it('quarantines malformed JSON lines instead of invoking the handler', async () => {
      const received: WorkerToOrchestratorMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      stdout.write('not valid json\n');
      await tick();

      expect(received).toHaveLength(0);
      const quarantined = transport.quarantineHandle().recent();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.direction).toBe('parent_from_child');
      expect(quarantined[0]?.errorMessage).toMatch(/json_parse/);
      expect(quarantined[0]?.raw).toBe('not valid json');
    });
  });

  describe('claim_decision', () => {
    it('serializes a granted claim_decision as a single NDJSON line', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const message: OrchestratorToWorkerMessage = {
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: 'claim-abc',
        kind: 'granted',
      };

      transport.send(message);

      const written = Buffer.concat(chunks).toString();
      expect(written).toBe(`${JSON.stringify(message)}\n`);
    });

    it('serializes a denied claim_decision with deniedPaths', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const message: OrchestratorToWorkerMessage = {
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: 'claim-abc',
        kind: 'denied',
        deniedPaths: ['src/foo.ts'],
      };

      transport.send(message);

      const written = Buffer.concat(chunks).toString();
      expect(written).toBe(`${JSON.stringify(message)}\n`);
    });

    it('parses incoming claim_lock from worker', async () => {
      const received: WorkerToOrchestratorMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      const workerMsg: WorkerToOrchestratorMessage = {
        type: 'claim_lock',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: 'claim-abc',
        paths: ['src/foo.ts', 'src/bar.ts'],
      };

      stdout.write(`${JSON.stringify(workerMsg)}\n`);
      await tick();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(workerMsg);
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

    it('quarantines malformed lines instead of crashing or invoking the handler', async () => {
      const received: OrchestratorToWorkerMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      input.write('{incomplete\n');
      await tick();

      expect(received).toHaveLength(0);
      const quarantined = transport.quarantineHandle().recent();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.direction).toBe('child_from_parent');
      expect(quarantined[0]?.errorMessage).toMatch(/json_parse/);
    });
  });

  describe('claim_lock', () => {
    it('serializes a claim_lock worker message as a single NDJSON line', () => {
      const chunks: Buffer[] = [];
      output.on('data', (chunk: Buffer) => chunks.push(chunk));

      const msg: WorkerToOrchestratorMessage = {
        type: 'claim_lock',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: 'claim-abc',
        paths: ['src/foo.ts'],
      };

      transport.send(msg);

      const written = Buffer.concat(chunks).toString();
      expect(written).toBe(`${JSON.stringify(msg)}\n`);
    });

    it('parses incoming claim_decision from orchestrator', async () => {
      const received: OrchestratorToWorkerMessage[] = [];
      transport.onMessage((msg) => received.push(msg));

      const orchMsg: OrchestratorToWorkerMessage = {
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: 'claim-abc',
        kind: 'denied',
        deniedPaths: ['src/foo.ts'],
      };

      input.write(`${JSON.stringify(orchMsg)}\n`);
      await tick();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(orchMsg);
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
