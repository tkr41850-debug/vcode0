# Phase 7 — End-user usage documentation

## Goal

Ship `docs/usage.md` as the single setup-and-use entry point for the
post-phase-6 system. After this phase, a new operator who has never
seen the codebase can clone the repo, pick one of the three deployment
topologies that ships out of phase 6, get to a working orchestrator +
worker, submit a feature, and watch it run — without reading any of
the implementation plans or jumping across `docs/deployment/`,
`docs/operations/`, and `docs/architecture/`.

This is a documentation-only phase: no code, no migrations, no
behavioral change. It exists because phases 0–6 leave operator
knowledge spread across `docs/deployment/worker-systemd.md`,
`docs/operations/README.md` (with sub-pages for verification, conflict
coordination, attach, warnings), and the architecture docs — none of
which is a "how do I actually use this" entry point.

## Background

After phase 6, the system supports three deployment topologies:

1. **Distributed** — orchestrator on one host, N workers on others, WebSocket between them.
2. **Single-machine, dual-process** — orchestrator + one (or more) `npm run worker` process on the same host over localhost WebSocket. Replaces the legacy in-process model.
3. **Single-machine, task-only** — `LocalWorkerPool` directly (`distributed.enabled=false`); tasks dispatch to local-spawn child processes via stdin/stdout, no WebSocket. Feature-phase work needs at least one WS worker, so this topology is only useful for task-graph testing or for development before a worker process is up.

The `docs/deployment/worker-systemd.md` file covers production install
narrative (useradd, systemd unit, hardening) but assumes the operator
already knows what they want. `docs/operations/` covers in-flight
behaviors (recovery, conflicts, warnings) but assumes the operator
already has a running system. The gap is the front-of-house: choose a
topology, follow concrete commands, end up with a system you can
actually use.

## Steps

One commit. The doc lives at the repo level (`docs/usage.md`), not
under `docs/operations/` or `docs/deployment/`, because it spans both
and is the entry point a first-time operator looks for by name.

---

### Step 7.1 — Author `docs/usage.md`

**What:** write a single-page operator-facing doc, structured around the
three topologies plus a daily-usage section. Each topology section has
copy-pasteable commands; the daily-usage section walks through
submitting a feature, monitoring it, and the most common operational
gestures (drain a worker, scale up workers, recover from a crash).

**Files:**

- `docs/usage.md` — new. Sections:
  - **Picking a topology.** A 5-line decision tree: production VMs → distributed; single laptop dev with feature-phase agents → dual-process; task-only smoke testing → local-spawn.
  - **Setup — distributed.** Cross-link to `docs/deployment/worker-systemd.md` for the per-VM install path. State the orchestrator-side requirements explicitly: bare repo path, listen address, registry token. Include a `worker.env` template snippet matching `deploy/systemd/worker.env.example` from phase 6. Note the `gvc0:gvc0` user requirement and that subprocess inheritance means the agent + verification commands run unprivileged.
  - **Setup — single-machine, dual-process.** Two-terminal walk-through: terminal 1 runs the orchestrator with `workerProtocol.enabled=true` and a chosen port; terminal 2 runs `GVC0_ORCHESTRATOR_URL=ws://localhost:<port> GVC0_WORKER_SECRET=... GVC0_WORKER_ID=local-dev npm run worker`. Note that `GVC0_WORKER_FS_ROOT` defaults to `~/.gvc0/worker` for ad-hoc dev.
  - **Setup — single-machine, task-only.** One-line: set `distributed.enabled=false` in config, run the orchestrator. Tasks dispatch to local-spawn child processes. State the limitation up front: feature-phase scopes will fail until a WS worker is up.
  - **Submitting work.** Concrete example: invoke whatever the operator-facing entry point is (TUI command, CLI subcommand — confirm against the codebase at write time) to create a feature graph. Show the expected TUI rendering: feature panel, task list, worker panel with the three-tier rendering from phase 3 step 3.6 (active / delayed / in recovery, enriched with phase-5 lease state).
  - **Daily operations.**
    - **Monitoring** — `journalctl -u gvc0-worker -f` for systemd, plus the TUI worker panel.
    - **Draining a worker** — `systemctl stop gvc0-worker` for systemd; SIGTERM for ad-hoc; explain the 60s drain budget and that in-flight runs reroute via lease release.
    - **Scaling up** — bring up another worker with a different `GVC0_WORKER_ID`. The picker absorbs it on the next tick.
    - **Recovering from a crash** — explain that there's nothing to do: orchestrator restart sweeps expired leases, worker restart picks a fresh `bootEpoch` and re-registers. Cross-link to `docs/operations/verification-and-recovery.md` for deeper detail.
    - **What to do when a feature stalls** — pointer to the warnings system in `docs/operations/warnings.md` and the conflict-coordination flow in `docs/operations/conflict-coordination.md`.
  - **Where to go next.** A short link section: deployment doc, operations docs, architecture docs.
- `docs/README.md` — append `usage.md` to the landing-page link list as the recommended first read for new operators.
- `README.md` (repo root) — add a "Getting started" pointer to `docs/usage.md` if no such pointer exists; otherwise leave it.

The doc cross-links into existing material rather than re-stating it.
`worker-systemd.md` stays the canonical install path for the
distributed topology — `usage.md` summarizes and points at it. Same
for the operations sub-pages.

**Tests:**

- No automated tests (documentation-only). The drift guard is the review subagent below: it cross-checks every command snippet against the artifacts and config keys actually shipped by phases 0–6.

**Verification:** `npm run check:fix && npm run check` (Markdown is part of the format/lint surface; no behavioral verification possible).

**Review subagent:**

> Verify `docs/usage.md`: (1) every env var named in a snippet matches a key recognized by `parseWorkerEnv` from phase 6 step 6.2 (no stale `GVC_*` prefix); (2) every config key matches the schema after phase 4 step 4.6 / phase 6 step 6.2 (`workerProtocol.enabled`, `distributed.enabled`, `distributed.remoteFeaturePhases.*`); (3) systemd commands match the unit name `gvc0-worker.service` from phase 6 step 6.6; (4) the three topologies match the post-phase-6 reality — no "single-process in-orchestrator feature-phase agent" mode is described as supported; the `GVC0_FORCE_REMOTE_AGENTS=0` dev escape is mentioned only as a dev-only override; (5) the daily-operations section's "drain" and "recover from crash" descriptions match the phase-5 lease semantics (60s drain → `worker_shutdown` → released; orchestrator-crash sweep on boot); (6) every cross-link resolves to an existing file. Flag any command that would not work as written. Under 350 words.

**Commit:** `docs(usage): single setup-and-use entry point for the distributed system`

---

## Scope

**In scope.** A single `docs/usage.md` covering: topology selection, setup commands per topology, submitting a feature, monitoring, draining a worker, scaling, crash recovery basics, and pointers to the existing deployment and operations docs.

**Out of scope.** Any of the in-flight operational depth that already lives in `docs/operations/` (verification, conflict coordination, warnings, attach) — `usage.md` cross-links rather than duplicates. Architecture explanation (defer to `ARCHITECTURE.md` and `docs/architecture/`). Tutorial-style guided onboarding ("your first feature graph") — out of scope; this is reference, not training. Multi-orchestrator HA setup (the system doesn't support it; phase 5 explicitly out-of-scope).

## Phase exit criteria

- The single commit lands; `npm run verify` passes (Markdown formatting only).
- `docs/usage.md` exists, is reachable from `docs/README.md`, and a fresh reader can follow any one of the three topology sections end-to-end without consulting another doc to get a working system.
- Review subagent confirms every command snippet matches the artifacts and config keys actually shipped by phases 0–6 (no stale prefix, no fictional CLI flag, no broken cross-link).
