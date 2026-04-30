import { PassThrough } from 'node:stream';
import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import {
  ChildNdjsonStdioTransport,
  NdjsonStdioTransport,
} from '@runtime/ipc/index';
import { Quarantine } from '@runtime/ipc/quarantine';
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

describe('quarantine integration', () => {
  it('orchestrator transport routes invalid worker frames to Quarantine', async () => {
    const { stdin, stdout } = createStreamPair();
    const quarantine = new Quarantine();
    const transport = new NdjsonStdioTransport(
      { stdin, stdout },
      { quarantine, agentRunId: 'run-7' },
    );
    const received: WorkerToOrchestratorMessage[] = [];
    transport.onMessage((m) => received.push(m));

    stdout.write('{"type":"unknown","taskId":"t","agentRunId":"r"}\n');
    stdout.write('not-json\n');
    await tick();

    const recent = quarantine.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]?.direction).toBe('worker_to_orchestrator');
    expect(recent[0]?.agentRunId).toBe('run-7');
    expect(received).toHaveLength(0);

    transport.close();
    stdin.destroy();
    stdout.destroy();
  });

  it('worker transport routes invalid orchestrator frames to Quarantine', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const quarantine = new Quarantine();
    const transport = new ChildNdjsonStdioTransport(input, output, {
      quarantine,
      agentRunId: 'run-8',
    });
    const received: OrchestratorToWorkerMessage[] = [];
    transport.onMessage((m) => received.push(m));

    input.write('{"type":"bogus"}\n');
    await tick();

    const recent = quarantine.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.direction).toBe('orchestrator_to_worker');
    expect(recent[0]?.agentRunId).toBe('run-8');
    expect(received).toHaveLength(0);

    transport.close();
    input.destroy();
    output.destroy();
  });
});
