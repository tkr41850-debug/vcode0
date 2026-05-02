---
phase: 12
slug: integration-polish
plan: 01
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-02
---

# Phase 12-01 — Validation Strategy

> Validation contract for the scripted non-TUI prompt-to-main proof and deterministic verify-agent flake audit.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest integration tests |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npm run test:integration -- prompt-to-main-e2e verify-flake-audit` |
| **Full suite command** | `npm run check` |
| **Estimated runtime** | Existing integration-suite runtime plus two focused deterministic tests |

---

## Sampling Rate

- **After Task 1:** Run `npm run test:integration -- prompt-to-main-e2e`.
- **After Task 2:** Run `npm run test:integration -- verify-flake-audit`.
- **After Task 3 / before phase verification:** Run `npm run test:integration -- prompt-to-main-e2e verify-flake-audit` and `npm run check`.
- **Max feedback latency:** Focused commands should fail before the full suite is required.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | Phase 12 SC1; REQ-PLAN-01; REQ-PLAN-02; REQ-EXEC-01; REQ-EXEC-02; REQ-INBOX-01; REQ-MERGE-01; REQ-MERGE-02; REQ-MERGE-04 | T-12-01-01; T-12-01-02; T-12-01-04 | Uses faux-provider/in-process harness only, scripts safe tmp-worktree git commands, and proves merge-train drain/main evidence without TUI or live-provider calls. | integration | `npm run test:integration -- prompt-to-main-e2e` | ❌ W0 | ⬜ pending |
| 12-01-02 | 01 | 1 | Phase 12 SC2; REQ-MERGE-04 | T-12-01-01; T-12-01-03; T-12-01-04 | Runs five isolated known-good verify-agent attempts through faux provider and fails unless all five pass. | integration | `npm run test:integration -- verify-flake-audit` | ❌ W0 | ⬜ pending |
| 12-01-03 | 01 | 1 | Phase 12 SC1; Phase 12 SC2; 12-03 evidence handoff | T-12-01-03; T-12-01-04 | Confirms focused evidence and full repository verification are green, with grep-friendly names and no 12-02/12-03 scope leakage. | integration/full suite | `npm run test:integration -- prompt-to-main-e2e verify-flake-audit && npm run check` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/integration/prompt-to-main-e2e.test.ts` — executable proof for Phase 12 SC1.
- [ ] `test/integration/verify-flake-audit.test.ts` — executable proof for Phase 12 SC2.
- [ ] `test/helpers/feature-lifecycle-fixture.ts` — narrow fixture extension only if existing merge-train/root-main assertions require it.

---

## Manual-Only Verifications

All 12-01 behaviors have automated verification. Manual TUI smoke, source-install dry-run, and final v1 traceability green-out are explicitly deferred to 12-02 and 12-03.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency is bounded by focused commands before full-suite verification
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-02
