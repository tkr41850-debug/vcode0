import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { ChildIpcTransport, IpcTransport } from '@runtime/ipc/index';

/**
 * Paired in-memory transport used by the in-process session harness. The
 * orchestrator side matches `IpcTransport` (what `PiSdkHarness` exposes to
 * `LocalWorkerPool`) and the worker side matches `ChildIpcTransport` (what
 * `WorkerRuntime` expects). Messages sent on one side are delivered to the
 * other side's registered `onMessage` handler synchronously.
 *
 * Sends that precede handler registration are buffered and flushed once a
 * handler is attached, so setup order does not matter.
 */
export interface LoopbackTransportPair {
  orchestrator: IpcTransport;
  worker: ChildIpcTransport;
}

export function createLoopbackTransportPair(): LoopbackTransportPair {
  let workerHandler: ((m: OrchestratorToWorkerMessage) => void) | undefined;
  let orchestratorHandler:
    | ((m: WorkerToOrchestratorMessage) => void)
    | undefined;

  const pendingToWorker: OrchestratorToWorkerMessage[] = [];
  const pendingToOrchestrator: WorkerToOrchestratorMessage[] = [];

  let closed = false;

  const orchestrator: IpcTransport = {
    send(message: OrchestratorToWorkerMessage): void {
      if (closed) return;
      if (workerHandler !== undefined) {
        workerHandler(message);
      } else {
        pendingToWorker.push(message);
      }
    },
    onMessage(handler: (message: WorkerToOrchestratorMessage) => void): void {
      orchestratorHandler = handler;
      while (pendingToOrchestrator.length > 0) {
        const next = pendingToOrchestrator.shift();
        if (next !== undefined) handler(next);
      }
    },
    close(): void {
      closed = true;
    },
  };

  const worker: ChildIpcTransport = {
    send(message: WorkerToOrchestratorMessage): void {
      if (closed) return;
      if (orchestratorHandler !== undefined) {
        orchestratorHandler(message);
      } else {
        pendingToOrchestrator.push(message);
      }
    },
    onMessage(handler: (message: OrchestratorToWorkerMessage) => void): void {
      workerHandler = handler;
      while (pendingToWorker.length > 0) {
        const next = pendingToWorker.shift();
        if (next !== undefined) handler(next);
      }
    },
    close(): void {
      closed = true;
    },
  };

  return { orchestrator, worker };
}
