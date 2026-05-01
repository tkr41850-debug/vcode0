# Phase 7 — End-user usage documentation

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: phase-6-deployment-packaging (deployment topologies, env templates, systemd unit), phase-5-leases-and-recovery (lease semantics for drain / crash recovery copy), phase-4-remote-feature-phases (remote feature-phase semantics), phase-3-multi-worker-scheduling (worker panel rendering)
- Default verify: npm run check:fix && npm run check
- Phase exit: npm run verify; have a fresh reader follow each of the three topology sections end-to-end on a clean checkout, without consulting another doc, and end up with a system they can submit work to.

Ships as 1 commit.

## Contract

- Goal: ship `docs/usage.md` as the single setup-and-use entry point for the post-track system. A new operator who has never seen the codebase can clone the repo, pick one of the three deployment topologies that ship out of `phase-6-deployment-packaging`, get to a working orchestrator + worker, submit a feature, and watch it run — without reading any implementation plan or jumping across `docs/deployment/`, `docs/operations/`, and `docs/architecture/`.
- Scope:
  - In:
    - Single `docs/usage.md` covering: topology selection, setup commands per topology, submitting a feature, monitoring, draining a worker, scaling, crash recovery basics, and pointers into the existing deployment + operations docs.
    - Cross-links from `docs/README.md` and the repo-root `README.md` so a fresh reader finds the doc by name.
  - Out:
    - In-flight operational depth that already lives in `docs/operations/` (verification, conflict coordination, warnings, attach) — `usage.md` cross-links rather than duplicates.
    - Architecture explanation (`ARCHITECTURE.md` and `docs/architecture/` own this).
    - Tutorial-style guided onboarding (`your first feature graph`) — this is reference, not training.
    - Multi-orchestrator HA setup (the system does not support it; out of scope for this track per `phase-5-leases-and-recovery`).
- Exit criteria:
  - Single commit lands; phase-exit verify passes (markdown formatting only).
  - `docs/usage.md` exists and is reachable from `docs/README.md` and the repo-root `README.md`.
  - A fresh reader can follow any one of the three topology sections end-to-end without consulting another doc to get a working system (see phase-exit smoke).
  - Review goal #1 confirms zero stale env-var prefixes, fictional CLI flags, or broken cross-links in the new doc.

## Plan

- Background: after `phase-6-deployment-packaging`, the system supports three deployment topologies — distributed (orchestrator + N WS workers), single-machine dual-process (orchestrator + one local `npm run worker` over localhost WS), and single-machine task-only (`distributed.enabled=false`, local-spawn task workers only, feature-phase agents unavailable). Operator knowledge currently spreads across `docs/deployment/worker-systemd.md` (production install: useradd, systemd, hardening — assumes the operator already knows what they want), `docs/operations/README.md` plus its sub-pages (in-flight behaviors only — assumes a running system), and the architecture docs. None of these is the front-of-house `how do I actually use this` entry point. The gap is choose-a-topology → concrete commands → working system.
- Notes: none.

## Steps

### 7.1 Author docs/usage.md [risk: low, size: M]

What: write a single-page operator-facing doc structured around the three topologies plus a daily-usage section. Each topology section is copy-pasteable; the daily-usage section walks through submitting a feature, monitoring, draining a worker, scaling up, and crash recovery. The doc lives at `docs/usage.md` (repo-doc top level), not under `docs/operations/` or `docs/deployment/`, because it spans both and is the entry point a first-time operator looks for by name. Cross-link existing material rather than re-state it: `worker-systemd.md` stays the canonical install path for the distributed topology; `usage.md` summarizes and points at it. Same for the operations sub-pages.

Files:
  - `docs/usage.md` (new). Sections:
    - **Picking a topology** — 5-line decision tree: production VMs → distributed; single laptop dev with feature-phase agents → dual-process; task-only smoke testing → local-spawn.
    - **Setup — distributed** — cross-link to `docs/deployment/worker-systemd.md` for the per-VM install path. Orchestrator-side requirements explicit: bare repo path, listen address, registry token. Include a `worker.env` template snippet matching `deploy/systemd/worker.env.example` from `phase-6-deployment-packaging` step 6.5. Note the `gvc0:gvc0` user requirement and that subprocess inheritance means the agent + verification commands run unprivileged.
    - **Setup — single-machine, dual-process** — two-terminal walk-through: terminal 1 runs the orchestrator with `workerProtocol.enabled=true` and a chosen port; terminal 2 runs `GVC0_ORCHESTRATOR_URL=ws://localhost:<port> GVC0_WORKER_SECRET=... GVC0_WORKER_ID=local-dev npm run worker`. Note `GVC0_WORKER_FS_ROOT` defaults to `~/.gvc0/worker` for ad-hoc dev.
    - **Setup — single-machine, task-only** — one-line: set `distributed.enabled=false`, run the orchestrator. Tasks dispatch to local-spawn child processes. State the limitation up front: feature-phase scopes will fail until a WS worker is up.
    - **Submitting work** — concrete example: invoke the operator-facing entry point (TUI command or CLI subcommand — confirm against the codebase at write time) to create a feature graph. Show the expected TUI rendering: feature panel, task list, worker panel with the three-tier rendering from `phase-3-multi-worker-scheduling` step 3.6, enriched with `phase-5-leases-and-recovery` lease state.
    - **Daily operations**:
      - Monitoring — `journalctl -u gvc0-worker -f` for systemd, plus the TUI worker panel.
      - Draining a worker — `systemctl stop gvc0-worker` for systemd; SIGTERM for ad-hoc. Explain the 60s drain budget and that in-flight runs reroute via lease release.
      - Scaling up — bring up another worker with a different `GVC0_WORKER_ID`. Picker absorbs it on the next tick.
      - Recovering from a crash — nothing to do: orchestrator restart sweeps expired leases, worker restart picks a fresh `bootEpoch` and re-registers. Cross-link `docs/operations/verification-and-recovery.md` for depth.
      - Stalled feature — pointer to `docs/operations/warnings.md` and `docs/operations/conflict-coordination.md`.
    - **Where to go next** — short link section: deployment doc, operations docs, architecture docs.
  - `docs/README.md` — append `usage.md` to the landing-page link list as the recommended first read for new operators.
  - `README.md` (repo root) — add a "Getting started" pointer to `docs/usage.md` if no such pointer exists; otherwise leave it.

Tests: none — documentation-only. The drift guard is review goal #1 below, which cross-checks every command snippet against the artifacts and config keys actually shipped by other phases in this track.

Review goals (cap 350 words):
  1. Every env var named in a snippet matches a key recognized by `parseWorkerEnv` from `phase-6-deployment-packaging` step 6.2 (no stale `GVC_*` prefix). Every config key matches the schema after `phase-4-remote-feature-phases` step 4.6 and `phase-6-deployment-packaging` step 6.2 (`workerProtocol.enabled`, `distributed.enabled`, `distributed.remoteFeaturePhases.*`).
  2. Systemd commands match the unit name `gvc0-worker.service` from `phase-6-deployment-packaging` step 6.6.
  3. Three topologies match the post-track reality: no "single-process in-orchestrator feature-phase agent" mode is described as supported; the `GVC0_FORCE_REMOTE_AGENTS=0` dev escape is mentioned only as a dev-only override.
  4. Daily-operations "drain" and "recover from crash" copy matches `phase-5-leases-and-recovery` lease semantics: 60s drain → `worker_shutdown` → released; orchestrator-crash sweep on boot.
  5. Every cross-link resolves to an existing file. Flag any command that would not work as written.

Commit: `docs(usage): single setup-and-use entry point for the distributed system`

---
Shipped in <SHA1>..<SHA1> on <YYYY-MM-DD>
