# Phase 8 Plan 04: Per-Task Transcript Surface — Research

**Researched:** 2026-04-29
**Domain:** TUI overlay architecture, worker-output data flow, render rate-cap, virtualization patterns
**Confidence:** HIGH (all findings verified by direct codebase inspection; no external library research needed)

---

<user_constraints>
## User Constraints (from 08-CONTEXT.md and project locked decisions)

### Locked Decisions
- Command-first / manual-wins model: no cursor-driven graph editor, no UI-local workflow state.
- UI state stays derived from authoritative deps/store state via `TuiViewModelBuilder`.
- Overlay lifecycle belongs in `app-overlays.ts`; keybinds belong in `CommandRegistry`.
- `@microsoft/tui-test` smoke lane is blocked by a pre-existing workerpool SIGSEGV — verification
  leans on focused unit/type tests instead.
- New surfaces must be additive and low-risk: extend the existing shell, do not replace it.

### Claude's Discretion
- Whether the transcript surface reuses `AgentMonitorOverlay` state or introduces a parallel
  `TaskTranscriptOverlay` component.
- Whether rate-cap is a simple `lastRenderAt` timestamp guard in `refresh()` or a more structured
  throttle helper extracted into `app-overlays.ts`.
- Line-cap magnitude for the transcript buffer (200 is the current monitor default; this slice may
  or may not change it).
- Keybind letter for the transcript toggle (all single-letter keys are accounted for below; see
  findings).

### Deferred Ideas (OUT OF SCOPE for 08-04)
- Config editor menu.
- Visible three-cancel-lever actions (task-preserve / task-clean / feature-abandon).
- Per-task cursor navigation inside the transcript.
- Persistent transcript storage beyond in-memory line-ring buffer.
- Full-screen terminal pager or scrollable transcript.
</user_constraints>

---

## Summary

Three prior slices (08-01 inbox, 08-02 merge-train, 08-03 manual DAG edit actions) are shipped.
The next slice must expose per-task transcript/worker output as a **first-class TUI surface**
derived from authoritative state, while keeping the UI state model intact and reusing existing
monitor/log plumbing where possible.

**The transcript data source already exists and is already plumbed end-to-end.** Worker output
arrives via `WorkerPool → compose.ts → TuiApp.onWorkerOutput → AgentMonitorOverlay.upsertLog`.
The `AgentMonitorOverlay` already maintains a per-`agentRunId` log map with a 200-line ring cap.
That component is already shown/hidden via the `m` keybind and the `/monitor` slash command.

The gap is that the existing monitor overlay is worker-centric (indexed by `agentRunId`, shows the
most-recently-active worker), not task-centric (indexed by `taskId`, shows output for the selected
DAG node). A per-task transcript surface needs to be DAG-selection-aware.

**Primary recommendation:** Build a lightweight `TaskTranscriptOverlay` that derives its content
from the same in-memory log map already held by `AgentMonitorOverlay`, filtered to the currently
selected task. Use the same boxed overlay, overlay-lifecycle, and refresh patterns as inbox and
merge-train. Add a render rate-cap in `TuiApp.onWorkerOutput` to prevent a flood of rapid IPC
frames from driving unnecessary `tui.requestRender()` calls.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Verified Basis |
|------------|-------------|----------------|----------------|
| Worker output ingestion | `src/compose.ts` → `TuiApp.onWorkerOutput` | `LocalWorkerPool` callback | Verified in compose.ts:684–688 |
| Per-run line buffer | `AgentMonitorOverlay.upsertLog` + `logs` Map | — | Verified in components/index.ts:152–181 |
| DAG selection tracking | `TuiApp.selectedNodeId` + `app-state.ts` helpers | `app-navigation.ts` | Verified in app.ts |
| Transcript overlay rendering | new `TaskTranscriptOverlay` component | `drawBox` utility | Pattern: InboxOverlay, MergeTrainOverlay |
| Transcript view-model derivation | new `TuiViewModelBuilder.buildTaskTranscript(...)` | `WorkerLogViewModel` (existing) | Pattern: buildInbox, buildMergeTrain |
| Overlay lifecycle | `app-overlays.ts` (new `transcriptHandle`) | `app.ts` private toggle method | Pattern: toggleInboxOverlay |
| Keybind registration | `CommandRegistry` DEFAULT_COMMANDS | `TuiCommandContext` | Pattern: toggle_inbox key 'i' |
| Rate-cap guard | `TuiApp` private state (`lastRenderAt`) | — | Gap — does not exist yet |
| Virtualization (line window) | render-time `slice(-N)` in component | 200-line ring in upsertLog | Already partial — upsertLog caps at 200 |

---

## Data Source Inventory

### 1. Primary: In-memory AgentMonitorOverlay log map [VERIFIED]

`AgentMonitorOverlay` in `src/tui/components/index.ts` holds:
```ts
private readonly logs = new Map<string, WorkerLogViewModel>();
private readonly maxLines = 200;
```

`WorkerLogViewModel` (from `src/tui/view-model/index.ts`):
```ts
export interface WorkerLogViewModel {
  id: string;          // agentRunId
  label: string;       // taskId string
  taskId: string;
  agentRunId: string;
  lines: string[];     // ring-capped at 200
  updatedAt: number;
}
```

The public surface is `getLogs()` (returns sorted array), `getSelectedWorkerId()`, and
`upsertLog(agentRunId, taskId, line, timestamp)`.

**Key gap:** there is no `getLogByTaskId(taskId)` method. The transcript surface needs to filter
`getLogs()` by `taskId`. Since an `agentRunId` maps 1:1 to a `taskId` (the run id is
`run-task:<taskId>`), this filter is a cheap O(n) linear scan over the log entries.

### 2. Secondary: IPC frame types [VERIFIED]

Two `WorkerToOrchestratorMessage` variants produce formatted worker output:
- `progress`: `{ type, taskId, agentRunId, message }` — tool-call progress lines
- `assistant_output`: `{ type, taskId, agentRunId, text }` — LLM assistant text

`formatWorkerOutput` in `src/compose.ts` also maps `request_help`, `request_approval`, `error`,
and `result` to human-readable strings. All six variants are already captured into the monitor
overlay.

### 3. Tertiary: Session transcript (file-backed) [VERIFIED, NOT FOR 08-04]

`FileSessionStore` in `src/runtime/sessions/index.ts` persists `AgentMessage[]` to
`.gvc0/sessions/<sessionId>.json`. `AgentRun.sessionId` carries the session id.

This is the durable transcript, but it is async file I/O and uses `AgentMessage` types (not
display-ready strings). Reading it from the TUI would require a new async accessor on `TuiAppDeps`
and would not be synchronously refreshable. **Defer to a later slice or Phase 9 (crash recovery /
transcript replay).**

The in-memory ring buffer in `AgentMonitorOverlay` is the correct and sufficient source for the
08-04 slice.

---

## Current View Seams

### `TuiApp.onWorkerOutput` [VERIFIED]
```ts
onWorkerOutput(runId: string, taskId: string, text: string): void {
  this.selectedWorkerId = pushWorkerOutput({
    monitorOverlay: this.monitorOverlay,
    runId,
    taskId,
    text,
  });
  this.refresh();   // <-- full refresh on every IPC frame
}
```

**Problem:** `this.refresh()` is called synchronously on every worker output frame. During active
execution bursts (assistant streaming), this can drive many unnecessary `tui.requestRender()` calls
per second. `tui.requestRender()` is called at the bottom of `refresh()` unconditionally when
started.

**Rate-cap opportunity:** guard `this.refresh()` inside `onWorkerOutput` with a timestamp check so
bursts coalesce to a maximum update rate (e.g. 8–10 Hz, ~100–125 ms between renders). State
updates to the overlay's internal buffer can still happen every frame; only the render trigger is
rate-capped.

### `TuiApp.refresh()` [VERIFIED]
```ts
refresh(): void {
  // rebuilds all view-models
  // if visible:
  if (this.overlays.monitorHandle !== undefined) { ... }
  if (this.overlays.inboxHandle !== undefined) { ... }
  if (this.overlays.mergeTrainHandle !== undefined) { ... }
  // always at end:
  if (this.started && this.interactiveTerminal) {
    this.tui.requestRender();
  }
}
```

Transcript overlay refresh follows the same guard pattern: rebuild only when the overlay handle is
defined.

### `OverlayState` [VERIFIED]

```ts
export interface OverlayState {
  monitorHandle: OverlayHandle | undefined;
  dependencyHandle: OverlayHandle | undefined;
  helpHandle: OverlayHandle | undefined;
  inboxHandle: OverlayHandle | undefined;
  mergeTrainHandle: OverlayHandle | undefined;
}
```

Adding `transcriptHandle: OverlayHandle | undefined` is the next additive step.

---

## Existing Patterns to Reuse

| New Need | Closest Analog | File | Match Quality |
|----------|----------------|------|---------------|
| Transcript overlay component | `InboxOverlay` (boxed list), `AgentMonitorOverlay` (split-pane) | `src/tui/components/index.ts` | Strong |
| Transcript view-model | `buildInbox(items)`, `buildMergeTrain(features)` | `src/tui/view-model/index.ts` | Exact |
| Overlay lifecycle | `toggleInboxOverlay`, `toggleMergeTrainOverlay` | `src/tui/app-overlays.ts` | Exact |
| Overlay state slot | `inboxHandle`, `mergeTrainHandle` | `src/tui/app-overlays.ts::OverlayState` | Exact |
| Keybind entry | `toggle_inbox` / `toggle_merge_train` | `src/tui/commands/index.ts` DEFAULT_COMMANDS | Exact |
| Context method | `toggleInbox`, `toggleMergeTrain` | `TuiCommandContext` | Exact |
| App-layer private toggle | `toggleInboxOverlay()`, `toggleMergeTrainOverlay()` | `src/tui/app.ts` | Exact |
| Refresh guard | `if (this.overlays.inboxHandle !== undefined) { ... }` | `src/tui/app.ts::refresh()` | Exact |
| Slash-command routing | `case 'inbox':`, `case 'merge-train':` | `src/tui/app-composer.ts` | Exact |

---

## Render Rate-Cap: Current State and Gap

### What exists [VERIFIED]
- `AgentMonitorOverlay.maxLines = 200`: caps the stored line buffer per run — this is buffer
  virtualization, not render throttling.
- `AgentMonitorOverlay` render method already uses `selected.lines.slice(-12)` and
  `selected.lines.slice(-6)` for display — this is render-time windowing (viewport virtualization).
- `this.tui.requestRender()` is called at the end of every `refresh()`.

### What is missing [VERIFIED]
There is no rate-cap on how often `refresh()` is triggered from `onWorkerOutput`. During LLM
streaming, `assistant_output` frames can arrive at many frames per second. Each frame calls
`this.refresh()` which calls `this.tui.requestRender()`. If pi-tui's `requestRender` does not
internally coalesce calls, this is a waste of render cycles and can cause perceptible flicker.

**No throttle hook, debounce utility, or lastRenderAt timestamp exists anywhere in the TUI layer.**

### Recommended rate-cap approach

Add a private timestamp to `TuiApp`:

```ts
private lastWorkerRenderAt = 0;
private readonly workerRenderIntervalMs = 100; // 10 Hz cap
```

In `onWorkerOutput`:

```ts
onWorkerOutput(runId: string, taskId: string, text: string): void {
  this.selectedWorkerId = pushWorkerOutput({ ... });
  const now = Date.now();
  if (now - this.lastWorkerRenderAt >= this.workerRenderIntervalMs) {
    this.lastWorkerRenderAt = now;
    this.refresh();
  }
}
```

This keeps the buffer always up to date but coalesces render triggers to at most 10 Hz. The
transcript overlay, when visible, picks up the latest buffer state on each triggered refresh.

Alternatively, a `scheduleRender` helper that posts a microtask/timeout refresh (and no-ops if one
is already pending) would decouple the rate cap from a wall-clock check, but the timestamp guard
is simpler to verify in unit tests.

---

## What the Minimal 08-04 Slice Should Include

### Must-haves
1. **`TaskTranscriptOverlay` component** in `src/tui/components/index.ts`
   - Takes a `TaskTranscriptViewModel` (selected task label + lines array).
   - Renders as a boxed overlay in the same `drawBox` pattern as `InboxOverlay`.
   - Display the last N lines that fit the overlay height (render-time window, not a separate cap).

2. **`TaskTranscriptViewModel` interface** in `src/tui/view-model/index.ts`
   ```ts
   export interface TaskTranscriptViewModel {
     taskId: string | undefined;
     label: string;       // e.g. "t-3: deploy service"
     lines: string[];     // last N lines from the run's buffer
   }
   ```

3. **`TuiViewModelBuilder.buildTaskTranscript(taskId, monitorLogs)`** in `src/tui/view-model/index.ts`
   - Accepts the currently-selected `taskId` and the `WorkerLogViewModel[]` from the monitor.
   - Returns `TaskTranscriptViewModel` with lines filtered to the selected task's run.
   - No task selected → empty label, empty lines with a "no task selected" placeholder.

4. **`transcriptHandle` slot** added to `OverlayState` in `src/tui/app-overlays.ts`.

5. **`toggleTranscriptOverlay` function** in `src/tui/app-overlays.ts` following the exact
   inbox/merge-train pattern.

6. **`hideAllOverlays` and `hasVisibleOverlay`** updated to include `transcriptHandle`.

7. **Keybind `r`** (currently unused) for transcript toggle added to `DEFAULT_COMMANDS` and
   `TuiCommandContext.toggleTranscript()`.

8. **`/transcript` slash command** in `executeSlashCommand` routing to
   `commandContext.toggleTranscript()`.

9. **Refresh guard** in `TuiApp.refresh()` for the transcript overlay, parallel to inbox/merge-train.

10. **Rate-cap on `onWorkerOutput`** using the `lastWorkerRenderAt` timestamp guard described above.

### Should-have (do in same slice, low complexity)
- Update the `hideTopOverlay` function in `app-overlays.ts` to close transcript in the right priority order.
- Update the `notice` string for transcript show/hide ("transcript shown", "transcript hidden").

### Defer
- Scrollable/pageable transcript (requires page offset state in the overlay — out of scope).
- Selection cursor within transcript lines (out of scope per command-first constraint).
- Persistent / file-backed transcript reading (requires async deps accessor and `AgentMessage` parsing).
- Configurable rate-cap interval via config (use hardcoded 100 ms in this slice).

---

## Keybind Availability [VERIFIED]

Current `TuiCommandKey` union:
```ts
type TuiCommandKey = 'space' | 'g' | 'm' | 'w' | 'h' | 'i' | 't' | 'd' | 'x' | 'q';
```

Unoccupied single-letter candidates for transcript: `r` is the most natural (runs/transcript).
`f` and `l` are also free. `r` should be added to the `TuiCommandKey` union.

---

## Component Design: TaskTranscriptOverlay

The closest analog is `InboxOverlay` (simple boxed list) rather than `AgentMonitorOverlay`
(split pane) because the transcript surface is task-scoped — the operator already has a selected
task. There is no need to show a worker list on the left.

```ts
// src/tui/components/index.ts (additive)
export class TaskTranscriptOverlay implements Component {
  private model: TaskTranscriptViewModel = { taskId: undefined, label: '', lines: [] };

  setModel(model: TaskTranscriptViewModel): void {
    this.model = model;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const body = this.model.lines.length === 0
      ? ['No output yet.']
      : this.model.lines;
    return drawBox(
      ` Transcript: ${this.model.label} [r/q/esc hide] `,
      body,
      safeWidth,
    );
  }

  invalidate(): void {}
}
```

The `drawBox` + `padWrapped` utilities already handle ANSI width, wrapping, and narrow-terminal
fallback. No new rendering helpers are needed.

---

## View-Model Design: buildTaskTranscript

```ts
// src/tui/view-model/index.ts (additive method on TuiViewModelBuilder)
buildTaskTranscript(
  taskId: TaskId | undefined,
  logs: WorkerLogViewModel[],
): TaskTranscriptViewModel {
  if (taskId === undefined) {
    return { taskId: undefined, label: 'no task selected', lines: [] };
  }
  const entry = logs.find((log) => log.taskId === taskId);
  if (entry === undefined) {
    return { taskId, label: taskId, lines: [] };
  }
  return {
    taskId,
    label: entry.label,
    // Caller passes getLogs(); slice is render-time windowing
    lines: entry.lines,
  };
}
```

The `selectedTaskId` is already available in `TuiApp.refresh()` via `selectedNode?.taskId`.
The `monitorOverlay.getLogs()` is already accessible (public method on `AgentMonitorOverlay`).

**Important:** `TuiAppDeps` does not need a new method. The transcript content comes from the
already-held `monitorOverlay` instance, not from the store or runtime. This keeps the surface
fully in-process and synchronous — no new deps boundary is needed.

---

## TuiApp Wiring: What Changes

In `src/tui/app.ts`:

1. Import `TaskTranscriptOverlay` from `@tui/components/index`.
2. Add `private readonly transcriptOverlay = new TaskTranscriptOverlay()`.
3. Add `transcriptHandle: undefined` to the `overlays` object.
4. In `refresh()`, add the guard:
   ```ts
   if (this.overlays.transcriptHandle !== undefined) {
     this.transcriptOverlay.setModel(
       this.viewModels.buildTaskTranscript(
         selectedNode?.taskId,
         this.monitorOverlay.getLogs(),
       ),
     );
   }
   ```
5. Add private `toggleTranscriptOverlay()` method calling `toggleTranscriptOverlay(...)`.
6. Add `lastWorkerRenderAt` and rate-cap guard in `onWorkerOutput`.
7. Wire `toggleTranscript: () => this.toggleTranscriptOverlay()` into `createTuiCommandContext`.

In `src/tui/app-command-context.ts`:

1. Add `toggleTranscript(): void` to `TuiCommandContext` interface.
2. Add `toggleTranscript: () => { toggleTranscript(); }` in the returned context object.

---

## Concrete Files Likely to Change

| File | Change | Risk |
|------|--------|------|
| `src/tui/components/index.ts` | Add `TaskTranscriptOverlay` class, export it | Low — additive |
| `src/tui/view-model/index.ts` | Add `TaskTranscriptViewModel` interface; add `buildTaskTranscript` method | Low — additive |
| `src/tui/app-overlays.ts` | Add `transcriptHandle` to `OverlayState`; add `toggleTranscriptOverlay`; update `hideAllOverlays`, `hasVisibleOverlay`, `hideTopOverlay` | Low — additive pattern |
| `src/tui/commands/index.ts` | Add `'toggle_transcript'` to `TuiCommandName`; add `'r'` to `TuiCommandKey`; add entry to `DEFAULT_COMMANDS`; add `toggleTranscript()` to `TuiCommandContext` | Low — pure extension |
| `src/tui/app-command-context.ts` | Add `toggleTranscript` to `CreateTuiCommandContextOptions` and returned context | Low — additive |
| `src/tui/app.ts` | Add `transcriptOverlay` field, handle in `refresh()`, `toggleTranscriptOverlay()`, rate-cap in `onWorkerOutput`, wire into `createTuiCommandContext` | Medium — multiple touch points but all follow established patterns |
| `src/tui/app-composer.ts` | Add `case 'transcript':` slash-command routing | Low — one case in switch |
| `test/unit/tui/view-model.test.ts` | Add `buildTaskTranscript` coverage: no-task, task-with-no-log, task-with-lines | Low — pure unit |
| `test/unit/tui/commands.test.ts` | Add `/transcript` slash-command routing test; add rate-cap test via `onWorkerOutput` mock | Low — follows existing test structure |

**Not changing:** `src/compose.ts`, `src/orchestrator/ports/index.ts`, `src/tui/app-deps.ts`,
`src/runtime/`, `src/persistence/`. The transcript surface is purely a TUI presentation layer
addition with no new runtime, store, or compose seam changes.

---

## Render Throttle: Verification Strategy

The rate-cap is in `TuiApp.onWorkerOutput`, which is the hardest method to cover in Vitest
(it calls `this.refresh()` which calls `this.tui.requestRender()`, and `TUI` is from pi-tui).

**Recommended approach:** extract the rate-cap decision into a pure helper:

```ts
// src/tui/app-overlays.ts or a new src/tui/render-gate.ts
export function shouldRenderAfterWorkerOutput(
  lastRenderAt: number,
  now: number,
  intervalMs: number,
): boolean {
  return now - lastRenderAt >= intervalMs;
}
```

This pure function is trivially unit-testable without instantiating `TUI`. The `TuiApp` then calls
it and, if `true`, calls `this.refresh()` and updates `this.lastWorkerRenderAt`.

---

## Focused Verification Recommendations

### High-value, low-cost tests
| Test | File | What to assert |
|------|------|----------------|
| `buildTaskTranscript` — no task | `test/unit/tui/view-model.test.ts` | Returns placeholder label, empty lines |
| `buildTaskTranscript` — task with log | `test/unit/tui/view-model.test.ts` | Returns correct lines for selected taskId |
| `buildTaskTranscript` — task not in logs | `test/unit/tui/view-model.test.ts` | Returns empty lines (not error) |
| `TaskTranscriptOverlay.render` — empty | `test/unit/tui/view-model.test.ts` | Contains "No output yet." |
| `TaskTranscriptOverlay.render` — with lines | `test/unit/tui/view-model.test.ts` | Lines appear inside box |
| `/transcript` slash routing | `test/unit/tui/commands.test.ts` | Calls `toggleTranscript` on context |
| Rate-cap helper | new `test/unit/tui/render-gate.test.ts` or inline in `view-model.test.ts` | `shouldRenderAfterWorkerOutput` returns false/true correctly |
| `OverlayState` hideAll/hasVisible | `test/unit/tui/view-model.test.ts` | `transcriptHandle` is included |

### Typecheck
`npm run typecheck` is the strongest single gate for the additive `OverlayState` field, the new
`TuiCommandKey` union member, and the updated `TuiCommandContext` interface.

### Smoke lane
Remains blocked by pre-existing workerpool SIGSEGV. Do not treat that as a regression signal for
this slice.

---

## Common Pitfalls

### Pitfall 1: Accessing monitorOverlay from refresh but skipping the overlay-visibility guard
**What goes wrong:** transcript content is rebuilt on every `refresh()` call even when not visible,
wasting a `getLogs()` scan per frame.
**Prevention:** Wrap the `buildTaskTranscript` call inside `if (this.overlays.transcriptHandle !== undefined)` exactly as inbox and merge-train do.

### Pitfall 2: Introducing async deps for transcript content
**What goes wrong:** Adding a `getTaskTranscript(taskId)` to `TuiAppDeps` that reads from
`FileSessionStore` introduces async I/O into the synchronous `refresh()` path.
**Prevention:** Use only `monitorOverlay.getLogs()` (in-memory, synchronous) for 08-04. Durable
transcript reading is a Phase 9 concern.

### Pitfall 3: Calling `this.refresh()` unconditionally in `onWorkerOutput`
**What goes wrong:** During LLM streaming, dozens of `assistant_output` frames per second each
trigger a full view-model rebuild and `tui.requestRender()` call.
**Prevention:** Add the `lastWorkerRenderAt` rate-cap guard before `this.refresh()`.

### Pitfall 4: Stealing the `m` keybind (agent monitor) for transcript
**What goes wrong:** The monitor overlay uses `m`. Using it for transcript would break the existing
monitor workflow.
**Prevention:** Use `r` (free, mnemonic: "run transcript"), and keep the monitor overlay on `m`.

### Pitfall 5: Confusing agentRunId with taskId in the log filter
**What goes wrong:** `AgentMonitorOverlay.logs` is keyed by `agentRunId` (`run-task:<taskId>`),
but `DagNodeViewModel.taskId` is a plain `TaskId` string. Filtering must compare
`WorkerLogViewModel.taskId` against `selectedNode.taskId`, not the Map key.
**Prevention:** Use `getLogs().find((log) => log.taskId === taskId)` — `WorkerLogViewModel.taskId`
is the plain task id (set from the IPC frame's `taskId` field in `upsertLog`).

---

## Architecture Diagram: Transcript Data Flow

```
IPC frame (progress / assistant_output)
  │
  ▼
compose.ts :: formatWorkerOutput()
  │  returns string | undefined
  ▼
compose.ts :: LocalWorkerPool callback
  │  ui.onWorkerOutput(agentRunId, taskId, text)
  ▼
TuiApp.onWorkerOutput()
  │  pushWorkerOutput() → monitorOverlay.upsertLog(agentRunId, taskId, line, ts)
  │  rate-cap check → if ready: this.refresh()
  ▼
TuiApp.refresh()
  │  selectedNode?.taskId  (from DAG selection)
  │  monitorOverlay.getLogs()  (in-memory sorted array)
  │
  ├──[if transcriptHandle defined]──▶ viewModels.buildTaskTranscript(taskId, logs)
  │                                   └──▶ transcriptOverlay.setModel(vm)
  │
  └──▶ tui.requestRender()

Operator presses 'r'
  │
  ▼
CommandRegistry → TuiCommandContext.toggleTranscript()
  │
  ▼
toggleTranscriptOverlay() in app-overlays.ts
  │
  ├─ if visible: hide, clear handle
  └─ else: tui.showOverlay(transcriptOverlay, { width:'80%', maxHeight:'55%', anchor:'bottom-center' })
```

---

## Open Questions

1. **Should transcript replace or complement the agent monitor?**
   - What we know: monitor is worker-centric (shows all active runs); transcript would be
     task-centric (shows the selected DAG node's run).
   - What's unclear: whether operators need both surfaces simultaneously.
   - Recommendation: keep both in 08-04. The monitor remains on `m` for all-workers view; the
     transcript on `r` for the focused task view. If they overlap confusingly, one can be hidden
     by default in a later slice.

2. **Rate-cap interval: 100 ms or configurable?**
   - What we know: 100 ms (10 Hz) is a reasonable default for terminal rendering.
   - What's unclear: whether pi-tui already coalesces `requestRender()` calls internally.
   - Recommendation: use 100 ms hardcoded in 08-04. If pi-tui already coalesces, the guard is
     a cheap no-op. If it does not, 100 ms is safe without being sluggish.

3. **Line display limit in the transcript overlay**
   - What we know: the ring buffer caps at 200 lines in `upsertLog`; the monitor render uses
     `slice(-12)` for the detail pane.
   - Recommendation: show the full buffer (up to 200 lines) in the transcript overlay and let
     `drawBox` / terminal scroll handle the visual clip. The overlay `maxHeight` constraint
     (`55%`) will naturally limit visible rows. Do not add a second slice in this slice.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `tui.requestRender()` does not internally coalesce rapid calls | Rate-cap section | If it does coalesce, the rate-cap guard is harmless no-op overhead; safe to include anyway |
| A2 | `r` is not currently bound in pi-tui's internal key handling | Keybind section | If pi-tui reserves `r` internally, a different key must be chosen |
| A3 | `WorkerLogViewModel.taskId` matches `DagNodeViewModel.taskId` (both plain task id strings) | Data source / pitfall 5 | If agentRunId is stored as taskId in some path, the filter would miss — verify in upsertLog call site |

A3 is verified: `upsertLog(agentRunId, taskId, line, ts)` stores `taskId` directly from the IPC
frame's `taskId` field. `DagNodeViewModel.taskId` comes from `Task.id`. These are the same value.
[VERIFIED: src/tui/components/index.ts:157–181, src/tui/app-overlays.ts:264–286]

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config | `vitest.config.ts` |
| Quick run | `npx vitest run test/unit/tui/view-model.test.ts` |
| Full unit | `npm run test:unit` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| REQ-TUI-01 | Per-task transcript is a first-class derived surface | unit | `npx vitest run test/unit/tui/view-model.test.ts` |
| REQ-TUI-06 | Power-user, command-first ergonomics preserved | unit | `npx vitest run test/unit/tui/commands.test.ts` |
| Rate-cap | `shouldRenderAfterWorkerOutput` returns correct boolean | unit | same file or `render-gate.test.ts` |

### Sampling Rate
- Per task commit: `npm run typecheck && npx vitest run test/unit/tui/`
- Per wave: `npm run check`
- Phase gate: `npm run check` green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] Add `buildTaskTranscript` cases to `test/unit/tui/view-model.test.ts`
- [ ] Add `TaskTranscriptOverlay` render cases to `test/unit/tui/view-model.test.ts`
- [ ] Add `/transcript` routing case to `test/unit/tui/commands.test.ts`
- [ ] Add rate-cap helper unit test (inline or new file)

---

## Sources

### Primary (HIGH confidence — direct codebase inspection)
- `src/tui/app.ts` — `onWorkerOutput`, `refresh()`, overlay wiring, `selectedNodeId`
- `src/tui/app-overlays.ts` — `OverlayState`, `pushWorkerOutput`, all toggle functions
- `src/tui/app-deps.ts` — `TuiAppDeps` interface
- `src/tui/components/index.ts` — `AgentMonitorOverlay`, `InboxOverlay`, `MergeTrainOverlay`, `drawBox`
- `src/tui/view-model/index.ts` — `WorkerLogViewModel`, `buildInbox`, `buildMergeTrain`, `TuiViewModelBuilder`
- `src/tui/commands/index.ts` — `TuiCommandKey`, `DEFAULT_COMMANDS`, `TuiCommandContext`
- `src/tui/app-command-context.ts` — `createTuiCommandContext`
- `src/tui/app-composer.ts` — `executeSlashCommand`, slash routing switch
- `src/compose.ts` — `formatWorkerOutput`, `ui.onWorkerOutput` call site
- `src/runtime/ipc/frame-schema.ts` — `ProgressFrame`, `AssistantOutputFrame`
- `src/runtime/sessions/index.ts` — `FileSessionStore` (confirmed out-of-scope for 08-04)
- `src/core/types/runs.ts` — `TaskAgentRun`, `sessionId` field
- `test/unit/tui/view-model.test.ts` — existing test patterns
- `test/unit/tui/commands.test.ts` — existing test patterns
- `.planning/phases/08-tui-surfaces/08-CONTEXT.md`
- `.planning/phases/08-tui-surfaces/08-PATTERNS.md`
- `.planning/phases/08-tui-surfaces/08-03-SUMMARY.md`
- `.planning/ROADMAP.md`

---

## Metadata

**Confidence breakdown:**
- Data source inventory: HIGH — all sources verified by direct file inspection
- Component/view-model design: HIGH — exact analogs verified in inbox and merge-train overlays
- Rate-cap approach: HIGH — gap confirmed (no throttle exists); approach is standard
- Keybind availability: HIGH — full `TuiCommandKey` union inspected; `r` is free
- Session transcript scope: HIGH — async/file path correctly identified and deferred

**Research date:** 2026-04-29
**Valid until:** Phase 8 completion (stable codebase; no external dependencies)
