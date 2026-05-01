# Phase 8: TUI Surfaces - Pattern Map

**Mapped:** 2026-04-29
**Files analyzed:** TUI app shell, overlays, commands, view-models, compose seam, TUI tests
**Analogs found:** exact or strong analogs for inbox, merge-train, and transcript surface work

---

## File Classification

| New/Modified Area | Role | Closest analog | Match quality |
|-------------------|------|----------------|---------------|
| inbox overlay | boxed list overlay | `DependencyDetailOverlay`, `AgentMonitorOverlay` | exact |
| inbox list view-model | derived list summarization | `buildComposer(...)`, `buildDependencyDetail(...)` | strong |
| inbox overlay lifecycle | overlay show/hide/notice wiring | `toggleHelpOverlay(...)`, `toggleDependencyOverlay(...)` | exact |
| inbox graph keybind | graph-focus command toggle | existing `h`, `m`, `d` command entries | exact |
| inbox slash-command routing | composer dispatch to deps | `reply`, `approve`, `reject`, `cancel` in `executeSlashCommand(...)` | exact |
| unresolved-only compose seam | TUI dep filtering | `snapshot()`, `listAgentRuns()`, `getWorkerCounts()` wiring in `src/compose.ts` | strong |
| merge-train surface | queue/status overlay | inbox overlay pattern | strong |
| transcript surface | live worker output surface | `AgentMonitorOverlay` | strong |
| config editor menu | command-first TUI action surface | slash-command autocomplete + composer submit flow | partial |
| visible cancel levers | explicit operator actions | existing feature cancel command | partial |

---

## Pattern Assignments

### 1. Derived list surface

**Use:** `src/tui/view-model/index.ts`

**Why:** presentation-only shaping already belongs here and stays independent from runtime/store helpers.

**Pattern to copy:**
- derive from authoritative records
- sort/filter in the builder
- emit short, render-ready summaries

**Applied in the inbox slice:** `buildInbox(items)`

**How to apply next:**
- merge-train surface should derive queue/attempt/cap summaries here
- transcript surface should derive compact task/run labels here if it becomes task-centric rather than worker-centric

---

### 2. Boxed overlay rendering

**Use:** `src/tui/components/index.ts`

**Why:** `drawBox(...)`, `padWrapped(...)`, and `padVisible(...)` already normalize narrow-width behavior and wrapping.

**Pattern to copy:**
```ts
return drawBox(' Title [key/q/esc hide] ', body, safeWidth);
```

**Applied in the inbox slice:** `InboxOverlay`

**How to apply next:**
- merge-train surface should be another boxed overlay with compact queue rows
- transcript surface can choose between boxed single-pane and split-pane variants based on width, following the monitor overlay

---

### 3. Overlay lifecycle wiring

**Use:** `src/tui/app-overlays.ts`

**Why:** visibility, handles, notices, and refresh behavior are already centralized.

**Pattern to copy:**
```ts
if (state.someHandle !== undefined) {
  state.someHandle.hide();
  state.someHandle = undefined;
  setNotice('... hidden');
  refresh();
  return;
}

state.someHandle = tui.showOverlay(component, { ... });
setNotice('... shown');
refresh();
```

**Applied in the inbox slice:** `toggleInboxOverlay(...)`

**How to apply next:**
- merge-train overlay should follow this exactly
- transcript surface can either follow this or reuse monitor-handle semantics if merged with worker output

---

### 4. Keybind registration

**Use:** `src/tui/commands/index.ts` + `src/tui/app-command-context.ts`

**Why:** graph-focus command toggles are already centralized and automatically feed help/status-bar hints.

**Pattern to copy:**
```ts
{
  name: 'toggle_inbox',
  key: 'i',
  label: 'inbox',
  description: 'Show or hide inbox overlay.',
  execute: (context) => {
    context.toggleInbox();
  },
}
```

**How to apply next:**
- merge-train surface should get its own explicit key only if it remains a separate first-class overlay
- transcript surface should avoid stealing keys already carrying worker-monitor semantics unless the monitor is upgraded/replaced intentionally

---

### 5. Slash-command action routing

**Use:** `src/tui/app-composer.ts`

**Why:** all command parsing and deps routing already converges here.

**Pattern to copy:**
```ts
case 'inbox-reply': {
  const inboxItemId = parsed.args.id;
  const text = parsed.args.text;
  ...
  return params.dataSource.respondToInboxHelp(inboxItemId, {
    kind: 'answer',
    text,
  });
}
```

**Applied in the inbox slice:** `/inbox`, `/inbox-reply`, `/inbox-approve`, `/inbox-reject`

**How to apply next:**
- merge-train surface actions should still route through deps rather than mutating store/UI directly
- config editor actions may start as slash commands before becoming a richer menu

---

### 6. Live refresh from authoritative deps

**Use:** `src/tui/app.ts::refresh()`

**Why:** this is the canonical place where surfaces rebuild from current graph/runs/inbox data.

**Pattern to copy:**
```ts
if (this.overlays.inboxHandle !== undefined) {
  this.inboxOverlay.setModel(
    this.viewModels.buildInbox(this.deps.listInboxItems()),
  );
}
```

**How to apply next:**
- every new Phase 8 overlay should refresh only when visible
- do not introduce polling or long-lived shadow caches in the component layer

---

## Test Patterns

### Unit test analogs
- `test/unit/tui/view-model.test.ts` — best place for derived-model ordering, summary, and width-bound assertions
- `test/unit/tui/commands.test.ts` — best place for slash-command routing and required-arg validation

### Smoke test analog
- `test/integration/tui/smoke.test.ts` — best place for overlay visibility, focus transitions, and keybind activation

### Verification caveat
- The smoke harness is currently blocked by `@microsoft/tui-test` workerpool `SIGSEGV`, so unit coverage is the most trustworthy surface-level verification at the moment.

---

## No Analog Found

The weakest analog remains the future config editor menu. The repo has strong command/autocomplete patterns and strong overlay patterns, but no current multi-field editing menu with hot-reload semantics inside the TUI.

Even there, the missing piece is interaction polish, not architecture:
- command routing already exists
- config loading already exists
- hot-reload classification already exists
- help/status/overlay patterns already exist

So the remaining Phase 8 work still extends the current architecture rather than requiring a greenfield subsystem.

---

## Metadata

**Analog search scope:** `src/tui/**`, `src/compose.ts`, focused TUI tests
**Pattern extraction date:** 2026-04-29
