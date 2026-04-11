# Optimization Candidate: Push-Based Reservation Overlap Detection

## Status

Future optimization candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline uses two overlap detection layers:

- **Reservation overlap** (tick-based): on each scheduler tick, the scheduler checks write-path reservations of ready work against running tasks. This is a scheduling-time penalty, not a hard block. Detection latency is bounded by the tick interval.
- **Runtime overlap** (push-based, already baseline): when a task attempts to write a file, the write prehook tries to claim an active path lock through the orchestrator. If the path is already locked, the incident routes immediately into the coordination flow.

The tick-based reservation check is acceptable for the local-machine baseline because:
- Task worktrees isolate blast radius — a task writing to its own worktree during the detection window doesn't corrupt shared state.
- Tick intervals of a few seconds keep the window small.
- Sequential tick processing means two overlapping results within one tick window are handled in order.

## Optimization

Make reservation-level detection push-based in addition to the existing push-based runtime detection:
- **File watcher**: inotify/fsevents on worktree directories to detect writes that might overlap with reservations, not just active locks.
- **Worker IPC event**: workers report file-write intent before committing, allowing the orchestrator to detect reservation overlap before the write lands.

## Motivation

- Reduces reservation-detection latency from tick-interval-bounded to near-immediate.
- Prevents wasted work: a task can be steered or suspended before it writes to a reserved path, rather than discovering the conflict at the next tick.
- Matters more as worker count grows — with many concurrent tasks, the probability of overlap during one tick window increases.

## Trade-offs

- Adds callback/watcher wiring complexity beyond the existing write prehook.
- Push-based detection can fire frequently in hot paths, requiring debounce or batching.
- The serial event queue still processes the detection event — push only reduces the *detection* latency, not the *response* latency.

## When to Consider

When the baseline tick-based reservation detection causes observable wasted work or conflict resolution delays under real workloads with multiple concurrent workers.
