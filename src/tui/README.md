# tui

Terminal UI layer for visualizing graph state and issuing operator commands.

This directory owns the pi-tui app shell, derived view-model state, components, overlays, and the current keyboard command surface.
It does not own scheduling or persistence logic; it reads snapshots and run state through the `TuiDataSource`/`UiPort` seam.

## Layout

- `app.ts` — `TuiApp` public shell and composition root for TUI helpers.
- `app-command-context.ts`, `app-composer.ts`, `app-navigation.ts`, `app-overlays.ts`, `app-state.ts`, `data-source.ts` — command callbacks, slash-command execution, navigation/input flow, overlay handling, selection/snapshot helpers, and TUI data contract.
- `commands/` — current keybind registry and user-facing command labels.
- `components/` — DAG, status bar, help, dependency detail, and agent monitor rendering.
- `view-model/` — derived DAG/status/worker/dependency view models from graph snapshots and agent runs.

## Sharp edges

- `commands/index.ts` is the source of truth for currently implemented keys (`space`, `g`, `m`, `w`, `h`, `d`, `x`, `q`). Keep broader doc references out of local command docs.
- Commands flow through `TuiDataSource` and orchestrator-owned actions; components should render derived state, not mutate workflow directly.
- Agent monitor logs are runtime-only UI state. They help operators, but they are not authoritative orchestration state.

## See also

- [Reference / TUI](../../docs/reference/tui.md)
- [Testing Strategy](../../docs/testing.md)
- [orchestrator](../orchestrator/README.md)
