/**
 * Worker child-process entry point.
 *
 * Forked by PiSdkHarness via child_process.fork().
 * Communicates with the orchestrator over NDJSON on stdin/stdout.
 * All console output is redirected to stderr so stdout stays clean for IPC.
 */

// Redirect console to stderr before any other imports can log
const stderrWrite = (msg: string) => process.stderr.write(`${msg}\n`);
console.log = stderrWrite;
console.info = stderrWrite;
console.warn = stderrWrite;

// console.error already goes to stderr

import type { OrchestratorToWorkerMessage } from '@runtime/contracts';
import { ChildNdjsonStdioTransport } from '@runtime/ipc/index';
import { Quarantine } from '@runtime/ipc/quarantine';
import { FileSessionStore } from '@runtime/sessions/index';
import { WorkerRuntime } from '@runtime/worker/index';
import { resolveWorkerProjectRoot } from '@runtime/worker/project-root';

const workerAgentRunId = process.env.GVC0_AGENT_RUN_ID;
const quarantine = new Quarantine();
const transport = new ChildNdjsonStdioTransport(process.stdin, process.stdout, {
  quarantine,
  ...(workerAgentRunId !== undefined ? { agentRunId: workerAgentRunId } : {}),
});
const projectRoot = resolveWorkerProjectRoot();
const sessionStore = new FileSessionStore(projectRoot);

let runtime: WorkerRuntime | undefined;
let initialized = false;

transport.onMessage((message: OrchestratorToWorkerMessage) => {
  // Health ping: reply synchronously on the IPC microtask, never route to the
  // agent loop. Keeps the heartbeat alive even when the agent is mid-tool-call.
  if (message.type === 'health_ping') {
    transport.send({ type: 'health_pong', nonce: message.nonce });
    return;
  }
  if (message.type === 'run' && !initialized) {
    initialized = true;

    runtime = new WorkerRuntime(transport, sessionStore, {
      projectRoot,
      getApiKey: (provider: string) => {
        if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
        if (provider === 'openai') return process.env.OPENAI_API_KEY;
        return undefined;
      },
    });

    runtime
      .run(
        {
          kind: 'task',
          task: message.task,
          payload: message.payload,
          model: message.model,
          routingTier: message.routingTier,
        },
        message.dispatch,
      )
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[worker] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  } else if (runtime !== undefined) {
    runtime.handleMessage(message);
  }
});
