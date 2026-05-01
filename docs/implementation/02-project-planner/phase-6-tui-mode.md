# Phase 6 — TUI mode + composer focus indicator

## Goal

Add an explicit TUI mode for project-planner chat with auto-enter on greenfield bootstrap, persistent session list, and a composer focus indicator that always shows which scope keystrokes route to. The composer chrome change is the smaller half; the chat surface is the larger half but reuses existing proposal-mirror and chat infrastructure.

## Scope

**In:** project-planner mode entry/exit; auto-enter on greenfield bootstrap result from Phase 5; composer focus indicator chrome with mode label (extends today's `ComposerStatus`); session list view (resume / start new); approval surface for project proposals (new graph-diff component, since none exists today); cancellation-approval step for topology changes affecting running tasks.

**Out:** rewriting the live-planner third dataMode (kept per `01-baseline` non-goal); changing existing slash command surfaces for normal commands; rewriting the proposal-mirror data flow; adding a feature-discuss composer scope (no TUI surface for discuss exists today — that is its own follow-up).

## Background

Verified state on `main`:

- `src/tui/app.ts` is the TUI shell. Composer chrome is **not** single-mode/no-label today: `src/tui/components/index.ts` already renders a `ComposerStatus` strip and `src/tui/view-model/index.ts` drives multiple composer modes (`command | draft | approval | task | live-planner | attached`). Phase 6 extends this strip with explicit scope labels — it does not introduce chrome from scratch. There is no project-planner composer scope and no feature-discuss composer scope today.
- Live proposal-mirror state for plan/replan lives in `src/tui/live-planner-sessions.ts` and is wired by `src/tui/app.ts`. `src/tui/proposal-controller.ts` is feature-scoped draft/edit/submit/approve only — Phase 6 does **not** reuse it as the project mirror; the project session attaches via the same live-planner-sessions surface (or a sibling).
- Slash commands are split: `src/tui/commands/index.ts` owns names, autocomplete, templates, and the keybind registry; execution routing lives in `src/tui/app-composer.ts`. `/project` registration touches both.
- `await_approval` exists for feature plan/replan today: proposals are stored from `src/tui/proposal-controller.ts`, surfaced as approval mode by `src/tui/view-model/index.ts`, and applied/rejected in `src/orchestrator/scheduler/events.ts`. Current UX is **status text plus `/approve` / `/reject` / `/rerun`** — there is no graph-diff component. Step 6.4 builds the diff surface from scratch (no `proposal-review.ts` exists today).
- `src/tui/composer-autocomplete.ts` and `src/tui/app-navigation.ts` already implement the focus-indicator chrome groundwork from `01-baseline` Phase 7. Step 6.1 extends, not replaces.
- Running-task cancellation today goes through `compose.cancelFeatureRunWork(...)` → `runtime.abortRun(...)` then store update. There is no proposal-side cancellation gate; current core protection in `src/core/proposals/index.ts` says "cancel the task first." Step 6.4 adds the proposal-side gate.
- Session list rendering will pull from `Store.listProjectSessions` (Phase 2). No equivalent exists on `main`; this is a Phase 2 dependency.
- `docs/reference/tui.md` documents the current TUI surfaces; needs an additive update for the new mode.

## Steps

Ships as **4 commits**, in order.

---

### Step 6.1 — Composer focus indicator

**What:** extend the existing `ComposerStatus` strip with an explicit scope label so the operator always sees where the next message goes. States to render:

- `composer · graph` — normal commands (default; covers `command` and `draft` composer modes).
- `composer · project planner: <session-id>` — when the project-planner mode is active (introduced by Step 6.2).
- `composer · feature plan: <feature-id>` — when attached to a feature plan/replan session (covers today's `live-planner` and `approval` modes for plan/replan).

The chrome is always visible; it does not auto-hide. When the composer is defocused (graph-focus mode), the chrome dims but still shows the most recent destination so the operator knows what `esc` will return to.

**Out of Step 6.1:** there is no feature-discuss composer scope today (no TUI surface for discuss). Adding one is its own follow-up; do not introduce it here.

**`esc` semantics.** Step 6.1 only changes the *label*; it does not change `esc` behavior. The existing `esc` behavior from `01-baseline` Phase 7 (defocus composer back to graph focus) is unchanged. Mode exit (leaving project-planner mode) is owned by Step 6.2 and is a separate keystroke / slash command — `esc` defocuses, it does not detach the session.

**Files:**

- `src/tui/components/index.ts` — extend the existing `ComposerStatus` to render the scope label. Source the label from a new `composerScope` view-model field.
- `src/tui/view-model/index.ts` — add `composerScope` derivation. Default `'graph'`; switch to project / feature variants based on active mode.
- `test/unit/tui/view-model.test.ts` — coverage for composerScope derivation across graph mode, project mode, and plan/replan attached modes.
- `test/integration/tui/smoke.test.ts` — render-layer assertion that the chrome label appears with the expected text in each mode.
- `docs/reference/tui.md` — describe the focus indicator chrome.

**Tests:**

- Default startup (no project session, no attached plan/replan) shows `composer · graph`.
- After entering project-planner mode (slash command), chrome shows `composer · project planner: <id>`.
- After detaching from project mode (Step 6.2's exit action), chrome returns to `composer · graph`.
- Composer chrome stays visible when composer is defocused (`esc`); label shows the most recent destination.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify focus indicator: (1) chrome line is always visible; (2) label text changes per mode; (3) defocused composer still shows the most recent destination; (4) view-model derivation is testable in isolation. Under 250 words.

**Commit:** `feat(tui): composer focus indicator chrome`

---

### Step 6.2 — Project-planner mode entry/exit + slash command

**What:** new slash command `/project` that toggles into project-planner mode. Entry actions: list active sessions; offer "start new session" or "resume <id>". Mode exit is an explicit *detach* action (e.g. `/project detach` or a re-issue of `/project` while attached); `esc` only defocuses the composer (existing 01-baseline phase 7 behavior) — it does not detach the session and does not cancel it. Cancellation is its own explicit operator action against the session.

**Picker.** No existing TUI session-picker pattern is reusable. Step 6.2 adds a new picker built on the existing `selectList` editor configuration in `src/tui/app.ts`; it is **not** a generalized inbox/help picker.

**Files:**

- `src/tui/commands/index.ts` — register `/project` command name + autocomplete.
- `src/tui/app-composer.ts` — wire `/project` execution routing (this is where slash execution lives, separate from the registry).
- `src/tui/project-planner-controller.ts` (new) — drive the mode lifecycle. On entry, fetch sessions via `Store.listProjectSessions`, present the picker, on selection attach to the session's event stream and proposal mirror via the live-planner-sessions surface.
- `src/tui/view-model/index.ts` — extend with project-planner mode state and session list state.
- `test/unit/tui/commands.test.ts` — coverage for the new slash command.
- `test/integration/tui/smoke.test.ts` — coverage for entry → pick → see chat surface.

**Tests:**

- Slash `/project` with no sessions presents the "start new" option only.
- Slash `/project` with one running session presents resume + start-new.
- Pick "start new" creates a session via the coordinator (Phase 4) and attaches.
- Pick "resume" attaches to the existing session without re-creating.
- `esc` from project mode defocuses the composer back to graph focus; the session keeps running and remains attached. Detach (mode exit) is a separate explicit action (`/project detach` or re-issue of `/project`).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify mode entry: (1) slash command registers; (2) session list pulls from Phase 2 Store helper; (3) entry attaches the proposal mirror and composer to the right session; (4) `esc` does not cancel the session; (5) cancellation is a separate explicit action. Under 350 words.

**Commit:** `feat(tui): project-planner mode entry and session picker`

---

### Step 6.3 — Auto-enter on greenfield bootstrap

**What:** consume the bootstrap result from Phase 5. If the result is `{ kind: 'greenfield-bootstrap', sessionId }`, the TUI initializes directly into project-planner mode attached to that session. The composer chrome shows `composer · project planner: <session-id>`. The user is in chat from the first frame.

**Dependency.** Today `initializeProjectGraph(...)` returns `{ milestoneId, featureId }` and `src/compose.ts` constructs `TuiApp` with no bootstrap result. Phase 5 introduces the `greenfield-bootstrap` shape and the auto-spawn; Step 6.3 cannot land before Phase 5.

**Files:**

- `src/tui/app.ts` — accept the bootstrap result on construction; set initial mode accordingly.
- `src/tui/app-deps.ts` — Phase 5 already changed `initializeProject(...)`'s return type to `{ kind: 'greenfield-bootstrap', sessionId } | { kind: 'existing' }`. Step 6.3 routes that signal into the composer / view-model state (e.g. add a `bootstrapResult` field on the deps surface that the composer reads at startup). Phase 5 owns the type change; Phase 6 Step 6.3 owns the consumption.
- `src/compose.ts` — pass the bootstrap result from `initializeProjectGraph` into `TuiApp` construction.
- `test/integration/tui/smoke.test.ts` — full smoke that greenfield startup lands in project-planner mode immediately.

**Tests:**

- Empty project + auto mode → TUI starts in project-planner mode with the auto-spawned session attached.
- Existing project + auto mode → TUI starts in graph mode (default).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify auto-enter: (1) greenfield bootstrap result is consumed by TUI; (2) project-planner mode is the initial mode in greenfield; (3) existing-project startup is unchanged; (4) chrome label correctly identifies the auto-spawned session. Under 250 words.

**Commit:** `feat(tui): auto-enter project-planner mode on greenfield`

---

### Step 6.4 — Project proposal approval + cancellation-approval surface

**What:** when a project session calls `submit`, the proposal review surface shows the proposed graph diff (added milestones, added features, removed features, edge changes). Today there is no graph-diff component — current feature-proposal UX is status text plus `/approve` / `/reject` / `/rerun`. Step 6.4 builds the diff surface as new TUI work.

**Cancellation gate.** If the proposal removes features that have running tasks or affects features in non-`pending` work states, render a separate "this will cancel N running task(s)" approval block. The operator must explicitly approve cancellation before the topology change applies. On approve-with-cancel, the cancel path goes through the existing `compose.cancelFeatureRunWork(...)` → `runtime.abortRun(...)` for each affected run, then the topology apply runs. On approve-without-cancel, the apply rejects with the structured "running tasks affected" reason from Phase 4 — no partial state.

**Files:**

- `src/tui/proposal-review.ts` (new) — graph-diff component for project-scope proposals. Renders added/removed milestones, added/removed features, and edge changes. Also renders the typed `ProposalRebaseReason` (defined and exported by Phase 4 Step 4.4) when a rebase signal arrives — both `kind: 'stale-baseline'` and `kind: 'running-tasks-affected'` get human-readable framing here.
- `src/tui/project-planner-controller.ts` (Step 6.2's controller) — wire the cancellation-approval block. Use `compose.cancelFeatureRunWork(...)` for the cancel path; on rejection, surface the Phase 4 `ProposalRebaseReason` via the diff component.
- `src/compose.ts` — if needed, expose a batched cancel-then-apply entry point so the TUI does not interleave half a cancel with the apply.
- `test/unit/tui/proposal-review.test.ts` (new) — unit coverage for the diff component: render adds/removes/edge-changes; render each `ProposalRebaseReason` variant.
- `test/integration/tui/smoke.test.ts` — coverage for the cancellation-approval flow.
- `docs/reference/tui.md` — describe the project-proposal review surface.

**Tests:**

- Approval of a topology-only proposal (no running tasks affected) applies cleanly.
- Approval of a `removeFeature(f-3)` proposal where `f-3` has a running task surfaces the cancellation-approval block; approve-without-cancel rejects with the Phase 4 `ProposalRebaseReason` (`kind: 'running-tasks-affected'`); approve-with-cancel cancels the task via `cancelFeatureRunWork` and then applies.
- Stale-baseline rejection (Phase 4 `ProposalRebaseReason` of `kind: 'stale-baseline'`) re-opens the session with a clear system message rendered by `proposal-review.ts`.
- Diff-component unit tests cover each render path in isolation.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify approval surface: (1) project diffs render correctly; (2) running-task-impact is detected and surfaced; (3) approve-without-cancel cleanly rejects; (4) approve-with-cancel applies both the cancellation and the topology change; (5) stale-baseline path re-opens the session. Under 400 words.

**Commit:** `feat(tui): project proposal approval and cancellation gate`

---

## Phase exit criteria

- All four commits land in order.
- `npm run verify` passes.
- Greenfield bootstrap attaches the operator to the auto-spawned project-planner session at startup.
- `/project` slash command opens the session picker mid-project.
- Composer focus indicator always shows the destination scope.
- Project-proposal approval surfaces handle topology, running-task impact, and stale-baseline rebase paths.
- Run a final review subagent across all four commits to confirm the TUI surface is coherent and operator guidance in `docs/reference/tui.md` is up to date.

## Notes

- **Hotkey vs slash command.** Slash command `/project` is consistent with existing TUI surfaces. A hotkey shortcut can be added later if friction shows up; not in this phase.
- **Persistence.** Session list state is computed from the store on entry; no in-memory cache. Fast enough at typical session counts (<10).
- **Cancellation-approval phrasing.** The surface text should make clear that approving cancellation is destructive (running tasks lose their progress). Avoid soft phrasing.
- **Approval interactions with feature-phase runs.** A project-proposal apply that adds new features does not auto-start their `discussing` phase; the existing scheduler logic does that on the next tick once the feature exists.
