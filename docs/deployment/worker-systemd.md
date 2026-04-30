# Worker deployment — repo checkout + systemd

Target audience: distributed-track worker VMs (post 02-distributed phase 5).

This doc describes the simplest viable deployment shape: clone the repo into the VM, install Node from the distro package manager, and run the worker entry under systemd. No bundling, no single binary, no container image. The worker process runs in a VM sandbox, so disk hygiene is not a concern — duplicated `node_modules` across many weak VMs is acceptable.

## When to use this

Use this for fleets of self-managed VMs (LAN, home lab, weak hosts) where the orchestrator is reachable on a known address and the trust boundary is the VM itself. For hardened deployments (untrusted networks, multi-tenant), put TLS termination in front (caddy / nginx) and tighten the systemd unit (`ProtectSystem=strict`, `NoNewPrivileges=true`, dedicated user, etc).

For ephemeral / per-job workers, prefer a container or a fresh VM image — the systemd-daemon shape assumes a long-lived host.

## Prerequisites

- Node.js >= 24 (per `CLAUDE.md`). On Alpine: `apk add nodejs npm git`. On Debian/Ubuntu: `apt install nodejs npm git`.
- Network reachability to the orchestrator's WebSocket port (default `7777` per phase 1 `workerProtocol` config).
- SSH access to the orchestrator's bare repo (phase 2 git transport). Add the worker's SSH public key to the orchestrator's authorized keys list, or use a shared deploy key.
- A dedicated unprivileged user (`gvc0`) with a writable scratch directory.

## Layout

```
/opt/gvc0/                     # repo checkout
/etc/gvc0/worker.env           # secrets + config (mode 0600)
/etc/systemd/system/
  gvc0-worker.service          # unit
/var/lib/gvc0/scratch/         # GVC0_WORKER_FS_ROOT (worktrees, session caches)
```

## Install

```sh
# 1. user + dirs
useradd --system --home-dir /var/lib/gvc0 --shell /usr/sbin/nologin gvc0
install -d -o gvc0 -g gvc0 -m 0750 /var/lib/gvc0/scratch

# 2. checkout
git clone https://github.com/<org>/gvc0.git /opt/gvc0
chown -R gvc0:gvc0 /opt/gvc0
sudo -u gvc0 -- sh -c 'cd /opt/gvc0 && npm ci'

# 3. config (edit before enabling)
install -d -m 0755 /etc/gvc0
install -m 0600 -o root -g gvc0 /dev/null /etc/gvc0/worker.env
chmod 0640 /etc/gvc0/worker.env  # readable by gvc0 group only

# 4. unit
install -m 0644 deploy/gvc0-worker.service /etc/systemd/system/

# 5. enable
systemctl daemon-reload
systemctl enable --now gvc0-worker.service
```

## systemd unit

`/etc/systemd/system/gvc0-worker.service`:

```ini
[Unit]
Description=gvc0 distributed worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gvc0
Group=gvc0
WorkingDirectory=/opt/gvc0
EnvironmentFile=/etc/gvc0/worker.env
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
# Optional hardening:
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/gvc0
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

`ExecStart=/usr/bin/npm run worker` adds a small shell + npm overhead per restart. For tighter restart latency, point directly at the entry script (substitute the actual path post-build):

```ini
ExecStart=/usr/bin/node /opt/gvc0/dist/runtime/remote/worker-entry-remote.js
```

Either form is fine. Keep it consistent with how `npm run worker` is wired in `package.json`.

## Environment file

`/etc/gvc0/worker.env` (mode 0640, owner `root:gvc0`):

```sh
# Required
GVC0_ORCHESTRATOR_URL=ws://orch.lan:7777
GVC0_WORKER_SECRET=<shared-secret-from-orchestrator-config>

# Optional — sensible defaults if omitted
GVC0_WORKER_ID=vm-03
GVC0_WORKER_FS_ROOT=/var/lib/gvc0/scratch
GVC0_WORKER_CAPABILITIES=task,feature_phase  # scopeKinds
GVC0_WORKER_HARNESS_KINDS=pi-sdk             # harnessKinds
GVC0_WORKER_MAX_CONCURRENT=2
```

The exact env-var names track phase 1 step 1.5 / phase 2 step 2.2 — check those phase docs for the canonical list. The shared secret is a bearer token; the orchestrator validates it on the `register` frame (phase 1 step 1.4 `SharedSecretAuthPolicy`).

## Operational notes

**Restart policy plays clean with leases.** `Restart=always` + `RestartSec=5` works because the post-phase-5 lease layer absorbs worker restarts: a restart bumps `bootEpoch`, the orchestrator sees a different `bootEpoch` on reconnect, drops all prior leases for that worker, and reroutes the runs via takeover (per decision 7, INVESTIGATION-architectural.md). Manual recovery is unnecessary.

**Crash recovery.** If the worker process dies while holding leases, `child.on('exit')` is unavailable to the orchestrator (process is on a different machine). The lease layer relies on missed heartbeats: lease expires after `ttlMs + graceMs` (default 30s + 15s = 45s), sweeper marks `expired`, takeover dispatches. No worker-side cleanup script needed.

**Orderly drain (optional).** To drain a worker before maintenance: `systemctl stop gvc0-worker` triggers SIGTERM. The worker handler should send `worker_shutdown` on its registry connection before closing (per decision 15) so the orchestrator marks leases `released` and reroutes without waiting for the grace period. Verify the worker entry handles SIGTERM cleanly before relying on this.

**TLS.** The default WebSocket transport is plaintext. For deployments crossing untrusted networks, terminate TLS on a reverse proxy (caddy is the simplest):

```
orch.example.com {
    reverse_proxy /worker localhost:7777
}
```

Then set `GVC0_ORCHESTRATOR_URL=wss://orch.example.com/worker` and bind orchestrator to `127.0.0.1:7777` only.

**Logs.** systemd captures stdout/stderr to the journal. `journalctl -u gvc0-worker -f` tails. The worker should not write logs to disk in the repo checkout — keep them in the journal so log rotation is the distro's problem.

**Updates.** To update the worker fleet:

```sh
ssh worker-vm 'cd /opt/gvc0 && git pull && npm ci && sudo systemctl restart gvc0-worker'
```

Each restart is a clean `bootEpoch` bump; in-flight runs go to takeover. For a coordinated rolling update, drain before restart (see Orderly drain). No special migration handling — schema lives on the orchestrator only.

**SSH key for git transport.** The worker pulls from the orchestrator's bare repo over ssh (phase 2 step 2.1). Generate a deploy key on the worker and append the public part to the orchestrator's `~/.ssh/authorized_keys` with a `command="git-shell"` restriction:

```
command="git-shell -c \"$SSH_ORIGINAL_COMMAND\"",no-pty,no-port-forwarding ssh-ed25519 AAAA... worker-vm-03
```

This locks the key to git operations only.

## Capacity tuning

- `GVC0_WORKER_MAX_CONCURRENT=N` controls how many runs the worker hosts in parallel (phase 3 step 3.4). Set per VM strength; 1–4 is typical for weak hosts.
- Heartbeat interval (default 5s) and lease TTL (30s) live in orchestrator config (`workerLeases.ttlMs`, etc per phase 5 step 5.2). Workers don't tune these.

## Anti-patterns

- **Don't share the repo checkout across workers via NFS.** Phase 2 explicitly avoids shared filesystem assumptions; bare-repo git is the sync seam. Each VM gets its own checkout.
- **Don't reuse `GVC0_WORKER_ID` across VMs.** It's the registry identity. Reuse causes lease confusion.
- **Don't run two systemd units pointing at the same scratch dir.** The worktree manager assumes exclusive ownership of `GVC0_WORKER_FS_ROOT`.
- **Don't put the shared secret in the unit file.** Use `EnvironmentFile=` with restrictive mode so `systemctl cat` doesn't leak it.

## Why not a single binary?

A bundled binary (`pkg`, `nexe`, `bun build --compile`) saves disk and avoids `npm install` time, but the gain is marginal for self-managed VMs. The repo-checkout path is:

- Easier to debug — `cd /opt/gvc0 && node --inspect ...` works in place.
- Easier to update — `git pull` is the entire delta application.
- Compatible with the existing `npm run` task surface — no separate build pipeline for the worker.

If the fleet ever moves to immutable VM images (per-job ephemeral), a bundled artifact may be worth revisiting. Until then, repo-checkout is the cheaper choice.
