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
import { FileSessionStore } from '@runtime/sessions/index';
import { WorkerRuntime } from '@runtime/worker/index';
import { resolveWorkerProjectRoot } from '@runtime/worker/project-root';

const transport = new ChildNdjsonStdioTransport();
const projectRoot = resolveWorkerProjectRoot();
const sessionStore = new FileSessionStore(projectRoot);

// REQ-EXEC-03: when GVC0_TEST_SKIP_HEALTH_PONG is truthy, swallow inbound
// `health_ping` frames instead of responding. Used exclusively by the
// integration smoke test to exercise the parent-side timeout path.
const skipHealthPong = process.env.GVC0_TEST_SKIP_HEALTH_PONG === '1';

let runtime: WorkerRuntime | undefined;
let initialized = false;

transport.onMessage((message: OrchestratorToWorkerMessage) => {
  // REQ-EXEC-03: health_ping is a pure IPC echo and MUST respond even if
  // the pi-sdk Agent is mid-tool-call. Keep this above the agent-loop
  // dispatch below so it is never gated on WorkerRuntime readiness.
  if (message.type === 'health_ping') {
    if (!skipHealthPong) {
      transport.send({ type: 'health_pong', ts: Date.now() });
    }
    return;
  }

  if (message.type === 'run' && !initialized) {
    initialized = true;

    // Plan 03-03: model selection is config-driven (REQ-CONFIG-01). The
    // harness sets these env vars from `config.models.taskWorker` before
    // forking. Missing values are a hard error — no implicit fallback, so
    // a misconfigured compose path fails loudly instead of silently using
    // a stale default.
    const provider = process.env.GVC0_TASK_MODEL_PROVIDER;
    const modelId = process.env.GVC0_TASK_MODEL_ID;
    if (provider === undefined || modelId === undefined) {
      process.stderr.write(
        '[worker] fatal: GVC0_TASK_MODEL_PROVIDER and GVC0_TASK_MODEL_ID must be set by the harness\n',
      );
      process.exit(1);
    }

    runtime = new WorkerRuntime(transport, sessionStore, {
      modelProvider: provider,
      modelId,
      projectRoot,
      getApiKey: (apiProvider: string) => {
        if (apiProvider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
        if (apiProvider === 'openai') return process.env.OPENAI_API_KEY;
        return undefined;
      },
    });

    runtime
      .run(message.task, message.payload, message.dispatch)
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
