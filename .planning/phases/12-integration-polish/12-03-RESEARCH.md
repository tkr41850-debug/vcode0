# Phase 12-03 Research: Source Install Runbook + Traceability

**Researched:** 2026-05-02
**Scope:** README/source-install dry-run and v1 requirement traceability closeout.

## Current Repository State

### Root README

- `README.md` does not exist at repository root.
- Existing overview lives in `ARCHITECTURE.md` and docs landing pages under `docs/`.
- A root README is required for Phase 12 success criterion 4 because the runbook must be visible to a fresh source checkout.

### Install and run commands

From `package.json`:

```json
"engines": { "node": ">=24" },
"scripts": {
  "check": "npm run check:fix; npm run format:check && npm run lint && npm run typecheck && npm run test",
  "test:tui:e2e": "command npx tui-test",
  "tui": "tsx src/main.ts",
  "postinstall": "node scripts/rebuild-node-pty.cjs"
}
```

Implications:

- README should state Node.js 24+.
- `npm install` is the intended source-install path.
- `npm run tui` is the intended interactive TUI entrypoint.
- `npm run tui -- --cwd <workspace>` is the useful dry-run command for isolating app state outside the source clone.
- `postinstall` must remain part of dry-run verification because 12-02 fixed Alpine/musl `node-pty` startup by rebuilding native bindings when needed.

### Existing docs anchors

- `ARCHITECTURE.md` provides the top-level thesis and docs entrypoints.
- `docs/README.md` is the main docs catalog.
- `docs/operations/testing.md` documents the split between Vitest and `@microsoft/tui-test`.
- `docs/foundations/newcomer.md` provides the prompt-to-main narrative.
- `docs/foundations/execution-flow.md`, `state-axes.md`, and `coordination-rules.md` provide the final Phase 11 documentation evidence for REQ-DOC-*.

## Source-Install Dry-Run Strategy

The dry-run must simulate a fresh user source checkout without mutating the active working tree.

Recommended command shape:

```bash
fresh_clone=$(mktemp -d)
git clone --local . "$fresh_clone/gvc0"
cd "$fresh_clone/gvc0"
npm install
workspace=$(mktemp -d)
mkdir -p "$workspace/.gvc0"
cat > "$workspace/gvc0.config.json" <<'JSON'
{
  "models": {
    "topPlanner": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "featurePlanner": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "taskWorker": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "verifier": { "provider": "anthropic", "model": "claude-haiku-4-5" }
  }
}
JSON
```

Then launch and assert startup with a PTY-aware wrapper. Acceptable proof paths:

1. `npm run tui -- --cwd "$workspace"` under `@microsoft/tui-test` style PTY if creating a temporary dry-run test is cheaper; or
2. a short one-off `script`/PTY command that starts the TUI, waits for startup output, and terminates it once `gvc0 progress` and init guidance are observed.

Do not use live provider calls. The startup screen does not require a live LLM request.

## Traceability Evidence Inventory

Use the following as the first-pass mapping for `.planning/REQUIREMENTS.md`.

### Planning

| Requirement | Evidence |
|---|---|
| REQ-PLAN-01 | Phase 7 top-level planner work; `docs/foundations/newcomer.md`; 12-01 prompt-to-main proof. |
| REQ-PLAN-02 | Phase 5 feature lifecycle/planner; `docs/architecture/planner.md`; feature-phase integration tests. |
| REQ-PLAN-03 | Phase 7 additive re-invocation semantics; proposal/unit coverage. |
| REQ-PLAN-04 | Phase 10 planner session picker/audit reader; proposal flows. |
| REQ-PLAN-05 | Phase 8 manual TUI graph editing and Phase 10 proposal collision surfacing. |
| REQ-PLAN-06 | Phase 7 persistence plus Phase 10 audit-log reader. |
| REQ-PLAN-07 | Phase 7 collision metadata and Phase 10 proposal review overlay. |

### Execution

| Requirement | Evidence |
|---|---|
| REQ-EXEC-01 | Phase 3 worker model; `docs/architecture/worker-model.md`; worker smoke/integration tests. |
| REQ-EXEC-02 | Phase 3/5 worker completion and commit-trailer tests; 12-01 prompt-to-main proof. |
| REQ-EXEC-03 | Phase 3 IPC schema/quarantine tests; worker model docs. |
| REQ-EXEC-04 | Phase 3 retry/failure routing; retry-policy tests; inbox routing evidence. |
| REQ-EXEC-05 | Phase 3 worker pool + Phase 4 scheduler cap; config evidence. |
| REQ-EXEC-06 | Phase 4 scheduler feature-dependency merged gate. |

### Merge train

| Requirement | Evidence |
|---|---|
| REQ-MERGE-01 | Phase 6 merge train implementation and integration tests; 12-01 merge-train drain proof. |
| REQ-MERGE-02 | Phase 6 rebase/verify/eject behavior; `integration-runner` tests. |
| REQ-MERGE-03 | Phase 6 re-entry cap and inbox park; concerns traceability. |
| REQ-MERGE-04 | Phase 5 initial verify-agent implementation, Phase 6 integration, 12-01 verify proof. |

### TUI and inbox

| Requirement | Evidence |
|---|---|
| REQ-TUI-01 | Phase 8 surfaces: DAG graph, inbox, merge train, task transcript; 12-02 TUI smoke. |
| REQ-TUI-02 | Phase 7 unified inbox model plus Phase 8 inbox overlay. |
| REQ-TUI-03 | Phase 8 manual graph editing commands. |
| REQ-TUI-04 | Phase 8 config overlay/editor. |
| REQ-TUI-05 | Phase 8 distinct cancel levers. |
| REQ-TUI-06 | Phase 8 docs-aligned pi-tui direction and power-user workflows. |
| REQ-INBOX-01 | Phase 7 request_help/await_response routing. |
| REQ-INBOX-02 | Phase 7 hot-window/checkpointed waits. |
| REQ-INBOX-03 | Phase 7 respawn/replay after checkpointed waits. |
| REQ-INBOX-04 | Phase 7 fanout/multi-task single answer. |

### State, config, docs

| Requirement | Evidence |
|---|---|
| REQ-STATE-01 | Phase 1/2 split state model; `docs/foundations/state-axes.md`; FSM tests. |
| REQ-STATE-02 | Phase 9 crash recovery UX; rehydration/recovery tests. |
| REQ-STATE-03 | Phase 1/2 milestone model; graph/persistence tests. |
| REQ-STATE-04 | Phase 7 milestone split/merge/manual planner semantics. |
| REQ-CONFIG-01 | Phase 2 config persistence plus package config schema/tests. |
| REQ-CONFIG-02 | Phase 2 cost/budget tracking and docs; enforcement deferred to REQ-CONFIG-V2-01. |
| REQ-CONFIG-03 | Phase 8 hot-reloadable config editor. |
| REQ-DOC-01 | `docs/foundations/execution-flow.md`; Phase 11 drift checks. |
| REQ-DOC-02 | `docs/foundations/state-axes.md`; Phase 11 drift checks. |
| REQ-DOC-03 | `docs/foundations/coordination-rules.md`; Phase 11 drift checks. |

## Open Questions (RESOLVED)

1. **Should the root README be created or should `docs/README.md` be treated as the runbook?**
   - Resolution: Create root `README.md`. Phase 12 explicitly says README/source-install runbook; a fresh clone should not need to discover `docs/README.md` first. [ASSUMED]

2. **Should source-install verification require live model credentials?**
   - Resolution: No. The verified dry-run only proves install and TUI startup. Live provider use belongs to actual operator usage and is configured by the user's `gvc0.config.json`. [ASSUMED]

3. **Can v1 traceability mark REQ-CONFIG-02 complete if budget enforcement is deferred?**
   - Resolution: Yes only for the v1 wording: visibility/configurable knobs exist while enforcement behavior is explicitly deferred to `REQ-CONFIG-V2-01`. The traceability row must state that boundary. [ASSUMED]

## Recommended Verification

Focused:

```bash
npm run test:tui:e2e
grep -n "REQ-PLAN-01\|Complete\|v1.x" .planning/REQUIREMENTS.md
```

Dry-run:

```bash
# Use a fresh local clone/copy, then:
npm install
npm run tui -- --cwd <temp-workspace>
```

Final:

```bash
npm run check && npm run test:tui:e2e
```

## Risks

| Risk | Mitigation |
|---|---|
| Interactive TUI command hangs dry-run | Use PTY wrapper/test harness and terminate after startup text is proven. |
| Fresh clone includes uncommitted local files only if copied incorrectly | Commit planning/runbook work before source dry-run or use a source copy that includes the working tree intentionally for pre-commit verification. |
| Requirements marked green without evidence | Keep evidence pointers in the traceability table and record follow-ups honestly. |
| README duplicates docs catalog | Keep README as install/run quickstart and link to docs landing pages. |
