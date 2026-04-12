#!/usr/bin/env node
/**
 * Worker entry point. Spawned by {@link ProcessWorkerPool} as a child process
 * per task. Reads {@link OrchestratorToWorkerMessage} frames from stdin and
 * writes {@link WorkerToOrchestratorMessage} frames to stdout.
 *
 * Phase 5 delivers the transport + lifecycle only. The child currently
 * acknowledges the run, reports a synthetic success, and exits. Phase 6
 * replaces the body of handleRun() with a real pi-agent-core Agent loop.
 */
import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { NdjsonWorkerStdioTransport } from '@runtime/ipc/index';

const transport = new NdjsonWorkerStdioTransport();

function send(message: WorkerToOrchestratorMessage): void {
  transport.send(message);
}

function handleRun(
  message: Extract<OrchestratorToWorkerMessage, { type: 'run' }>,
): void {
  send({
    type: 'progress',
    taskId: message.taskId,
    agentRunId: message.agentRunId,
    message: `worker ${process.pid} running ${message.taskId}`,
  });

  send({
    type: 'result',
    taskId: message.taskId,
    agentRunId: message.agentRunId,
    result: {
      summary: `[phase5-stub] completed ${message.taskId} in pid ${process.pid}`,
      filesChanged: [],
    },
    usage: {
      provider: 'phase5-stub',
      model: 'none',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usd: 0,
    },
  });

  // Signal readiness to exit; parent will close stdin.
  process.exit(0);
}

transport.onMessage((message) => {
  switch (message.type) {
    case 'run':
      handleRun(message);
      break;
    case 'abort':
      process.exit(0);
      break;
    default:
      // Phase 5 ignores other control messages; Phase 6 wires them.
      break;
  }
});

// Prevent the child from exiting before a message arrives.
process.stdin.resume();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
