# Milestones

## v1 — gvc0 DAG-first autonomous coding orchestrator

**Status:** Shipped 2026-05-03
**Phases:** 12/12 complete
**Plans:** 42/42 complete
**Requirements:** 37/37 v1 requirements complete
**Audit:** Passed — see [v1-MILESTONE-AUDIT.md](milestones/v1-MILESTONE-AUDIT.md)

### Archives

- [Roadmap archive](milestones/v1-ROADMAP.md)
- [Requirements archive](milestones/v1-REQUIREMENTS.md)
- [Milestone audit](milestones/v1-MILESTONE-AUDIT.md)

### Key accomplishments

- Clarified the DAG-first execution model with pure core contracts, FSM guards, persistence contracts, and canonical docs.
- Shipped process-per-task worker execution with NDJSON IPC, write-prehook safety, commit trailers, retry policy, and checkpoint/resume behavior.
- Built the scheduler, feature lifecycle, verifier, and strict-main merge train with integration proof coverage.
- Delivered top-level planning, feature-level planning, unified inbox, pause/resume, replanning, and collision surfaces.
- Shipped the pi-tui operator surfaces for DAG, inbox, merge train, transcripts, manual edits, config, and cancel controls.
- Closed Phase 12 with true prompt-to-main E2E proof, TUI smoke, source-install runbook, and v1 traceability/audit pass.

### Deferred to v2 / future work

- Release packaging/global distribution.
- Budget enforcement behavior.
- Merge-train throughput optimizations.
- Phase 4 technical-debt follow-ups recorded in STATE.md.

