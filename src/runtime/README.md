# runtime

Local execution runtime for workers and sessions.

This directory owns worker lifecycle management, IPC transport, session harnessing, context assembly, model routing, and the worker agent's system prompt (assembled from `WorkerContext` and submitted directly to the harness).

It does **not** own the worker agent's tool catalog — that lives under [`@agents/worker`](../agents/worker/README.md). The runtime wires those tools into the pi-sdk `Agent` via an `IpcBridge` seam so tools stay decoupled from child-process plumbing.
