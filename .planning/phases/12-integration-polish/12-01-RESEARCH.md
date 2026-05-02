# Phase 12-01: Integration & Polish - Research

**Researched:** 2026-05-02
**Domain:** deterministic Vitest integration proof for prompt-to-main lifecycle plus verify-agent flake audit
**Confidence:** HIGH for repo-specific harness seams; MEDIUM for exact implementation split until planner sizes runtime cost

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

## Implementation Decisions

### 12-01 scope
- 12-01 covers the non-TUI integration proof: scripted prompt-to-main-style lifecycle coverage and verify-agent flake-rate audit.
- 12-02 remains responsible for `@microsoft/tui-test` golden-path smoke coverage.
- 12-03 remains responsible for README/source-install runbook and final v1 traceability green-out.

### End-to-end proof shape
- Prefer deterministic executable tests over manual scripts for 12-01.
- Use the existing Vitest integration harness and faux-provider patterns rather than live model calls.
- The scenario should exercise a realistic lifecycle chain through planner/approval/inbox/worker/verify/merge-train semantics as far as current test harness boundaries support.
- If a literal human-typed prompt through the TUI is only feasible in 12-02, 12-01 should document the boundary and cover the underlying orchestrator/runtime flow in Vitest.

### Verify-agent flake audit
- The flake audit should be deterministic and repeatable in CI or an explicit npm script.
- It should run the known-good verification path 5 times and fail if consistency is below 90%.
- Because 5 repeats makes pass thresholds awkward, use 5/5 pass consistency unless the implementation records a richer numerator/denominator that can represent 90% exactly.
- Do not call live LLM providers; use faux provider or existing deterministic verify-agent harness seams.

### Existing blockers to respect
- `@microsoft/tui-test` is pre-1.0 and has a known workerpool `SIGSEGV` history; keep 12-01 out of the TUI e2e lane.
- Existing parallel-vitest flakes are known from earlier phases; avoid adding a new parallel-load-sensitive test if the same behavior can be checked deterministically.
- Phase 12 should prove integration, not rewrite architecture.

### Claude's Discretion

No explicit Claude's Discretion section exists in CONTEXT.md. Specific ideas are advisory only:

## Specific Ideas

- Consider adding a dedicated `test/integration/prompt-to-main-e2e.test.ts` or extending an existing integration test if that avoids duplicate harness setup.
- Consider adding a focused verify flake audit test or script that repeats deterministic verify-agent review 5 times and reports pass consistency.
- Keep test names and output grep-friendly so 12-03 can cite them in final traceability.
- If `npm run check` would become too slow, prefer a focused test in default Vitest plus an explicit npm script only if the runtime cost justifies it.

### Deferred Ideas (OUT OF SCOPE)

## Deferred Ideas

- TUI golden-path smoke belongs to 12-02.
- README/source-install dry-run and v1 traceability green-out belong to 12-03.
- Full live-provider verify flake auditing remains out of scope for v1 unless a deterministic harness cannot satisfy the roadmap criterion.
</user_constraints>

## Summary

12-01 should be planned as a deterministic Vitest integration slice, not a manual demo and not a TUI E2E slice. The best seam is the existing `createFeatureLifecycleFixture()` because it already wires a real `SchedulerLoop`, `PiFeatureAgentRuntime`, `LocalWorkerPool`, in-process `WorkerRuntime`, faux provider, real tmp git repositories, real worker commits, and `VerificationService` together without live LLM calls. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:33-60] It currently proves planning approval, task execution, ci_check, verify, and reaching `awaiting_merge`; 12-01 should extend that style to include one inbox wait/answer and merge-train drain semantics. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:13-34] [VERIFIED: /home/alpine/vcode0/test/integration/worker-smoke.test.ts:144-209]

For verify-agent flake audit, the repo already models verify as a real pi-sdk agent loop over `PiFeatureAgentRuntime.verifyFeature()` using the global faux provider, `submitVerify`, feature worktree diffs, and persisted `payloadJson`. [VERIFIED: /home/alpine/vcode0/src/agents/runtime.ts:257-304] [VERIFIED: /home/alpine/vcode0/test/unit/agents/verify-contract.test.ts:134-175] The audit should run five deterministic known-good verify invocations with isolated tmp worktrees and fresh/fed faux responses, report `5/5`, and fail on anything less than five passes unless a richer denominator is implemented. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:38-43]

**Primary recommendation:** Add a focused `test/integration/prompt-to-main-e2e.test.ts` that reuses `createFeatureLifecycleFixture()` and add a grep-friendly deterministic verify flake audit test or `npm run test:verify-flake` script; do not touch `test/integration/tui/**`, README runbooks, or final REQ traceability in 12-01. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:27-47]

## Project Constraints (from CLAUDE.md)

- Single root TypeScript package, not a monorepo; maintain boundaries under `src/` using path aliases `@app/*`, `@core/*`, `@orchestrator/*`, `@agents/*`, `@runtime/*`, `@persistence/*`, and `@tui/*`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:46-56]
- Keep `@core/*` pure and do not make it depend on runtime, persistence, or TUI. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:140-144]
- Tests use Vitest; integration tests live under `test/integration/**/*.test.ts` and `test/integration/**/*.spec.ts`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:99-118]
- Integration tests should use pi-sdk faux provider patterns, not live API calls. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:111-118]
- Before commit-time verification, run `npm run check:fix`; full verification command is `npm run check`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:11-44] [VERIFIED: /home/alpine/vcode0/CLAUDE.md:131-136]
- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; module system is ESM with NodeNext; Node version is `>=24`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:123-129]
- Use conventional commits only if a commit is explicitly requested by the orchestrator/user. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:131-136]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Scripted prompt-to-main lifecycle proof | Orchestrator / Runtime test harness | Agents / Git | Scheduler events own state transitions; worker/runtime owns task execution; agents consume faux responses; git validates real commits and merge semantics. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:33-60] |
| Planner proposal approval | Orchestrator | Agents | `top_planner_requested`, `top_planner_approval_decision`, and `feature_phase_approval_decision` are scheduler events; agents only produce proposal payloads. [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/events.ts:652-777] [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/events.ts:812-879] |
| Inbox wait and answer | Runtime / Orchestrator | Store | Worker emits `request_help`; scheduler/store creates unresolved inbox rows; `respondToInboxHelp()` fans answer back to runtime. [VERIFIED: /home/alpine/vcode0/test/integration/worker-smoke.test.ts:144-209] [VERIFIED: /home/alpine/vcode0/test/integration/worker-smoke.test.ts:457-650] |
| Verify-agent flake audit | Agents test harness | Git worktree / Store | `PiFeatureAgentRuntime.verifyFeature()` runs the verify prompt/tool loop and persists the structured verdict; worktree diff is part of prompt context. [VERIFIED: /home/alpine/vcode0/src/agents/runtime.ts:257-304] [VERIFIED: /home/alpine/vcode0/src/agents/runtime.ts:321-358] |
| Merge-train drain | Orchestrator / Git | Agents / VerificationService | `runIntegrationIfPending()` rebases, runs shell verification, runs agent review with `run-integration:<featureId>`, fast-forwards main, then emits `feature_integration_complete`. [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/integration-runner.ts:33-90] |

## Standard Stack

### Core

| Library / Tool | Installed Version | Current Registry Version | Purpose | Why Standard for 12-01 |
|---|---:|---:|---|---|
| Vitest | `^4.1.4` | `4.1.5`, registry modified 2026-04-23 | Unit/integration runner | Existing repo test runner; default `npm run test` uses `vitest run`. [VERIFIED: /home/alpine/vcode0/package.json:19-24] [VERIFIED: npm registry] |
| `@mariozechner/pi-agent-core` | `^0.66.1` | `0.72.1`, registry modified 2026-05-02 | pi-sdk Agent runtime used by planner/verifier/worker tests | Existing agent stack; tests should use faux provider rather than live models. [VERIFIED: /home/alpine/vcode0/package.json:43-45] [VERIFIED: npm registry] |
| pi-ai faux provider via `@mariozechner/pi-agent-core` dependency tree | repo wrapper | bundled with pi-ai dependency | Deterministic scripted assistant turns | Existing `createFauxProvider()` wraps `registerFauxProvider()` and re-exports `fauxAssistantMessage`, `fauxText`, `fauxToolCall`. [VERIFIED: /home/alpine/vcode0/test/integration/harness/faux-stream.ts:1-30] |
| `simple-git` | `^3.35.2` | `3.36.0`, registry modified 2026-04-12 | Git setup and merge assertions | Existing merge-train and feature worktree tests use it and/or mocked imports. [VERIFIED: /home/alpine/vcode0/package.json:43-49] [VERIFIED: npm registry] |
| Node.js | `>=24`; local `v24.13.0` | local runtime | Test runtime | Required by `package.json` and available locally. [VERIFIED: /home/alpine/vcode0/package.json:7-9] [VERIFIED: command -v/node --version] |

### Supporting

| Library / Harness | Purpose | When to Use |
|---|---|---|
| `createFeatureLifecycleFixture()` | Full scheduler + feature-agent + worker-pool + faux + tmp-git lifecycle harness | Use for prompt-to-main-style scenario because it is the only existing seam with real worker commits and scheduler traffic together. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:33-60] |
| `InProcessHarness` | Runs `WorkerRuntime` in-process behind `SessionHarness` without child-process cost | Use to avoid fork/PTY flakiness while still exercising worker agent loop. [VERIFIED: /home/alpine/vcode0/test/integration/harness/in-process-harness.ts:25-35] |
| `InMemoryStore` / `InMemorySessionStore` | Store/session doubles for fast deterministic tests | Use for 12-01 default integration tests unless persistence itself is under test. [VERIFIED: /home/alpine/vcode0/test/integration/harness/README.md:10-15] |
| `createMergeTrainScenario()` | Persistent graph + merge coordinator fixture around in-memory SQLite | Use only if a separate merge-train unit/integration assertion is cleaner than extending lifecycle fixture. [VERIFIED: /home/alpine/vcode0/test/integration/harness/merge-train-scenario.ts:38-49] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| New manual shell script | Vitest integration test | Manual scripts are less CI-friendly and conflict with the 12-01 decision to prefer deterministic executable tests. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:32-36] |
| TUI E2E with `@microsoft/tui-test` | Non-TUI Vitest seam | TUI golden path is explicitly 12-02; `@microsoft/tui-test` currently has known workerpool `SIGSEGV` history. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:44-47] |
| Live provider verify audit | Faux-provider verify audit | Live-provider flake audit is explicitly out of scope; deterministic faux path is required. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:38-43] |
| Vitest `test.repeats` | Explicit loop with per-run isolation | Vitest docs include a `repeats` option for rerunning tests, but explicit loops make numerator/denominator reporting easier for the roadmap criterion. [CITED: https://vitest.dev/api/test] [ASSUMED] |

**Installation:** none recommended for 12-01. Use existing dependencies. [VERIFIED: /home/alpine/vcode0/package.json:30-50]

## Architecture Patterns

### System Architecture Diagram

```text
12-01 Vitest scenario

seed scripted prompt/event
  → SchedulerLoop event queue
    → top/feature planner faux Agent emits proposal
      → approval event applies proposal
        → scheduler dispatches ready task
          → LocalWorkerPool
            → InProcessHarness
              → WorkerRuntime + faux Agent
                → request_help? ──→ worker_message → scheduler/store inbox row
                    ↑                                  ↓
                    └──────── respondToInboxHelp() ← test answer
                → run_command/git commit/submit
          → worker_message commit_done/result
        → task lands on feature branch
    → ci_check via VerificationService
    → verify via PiFeatureAgentRuntime.verifyFeature() + faux submitVerify
    → awaiting_merge / merge_queued / integrating
    → runIntegrationIfPending: rebase → shell verify → agent verify → git ff merge
    → feature_integration_complete
    → summarize or budget-mode completion
    → assert work_complete + collab merged + main contains expected commit(s)
```

### Recommended Project Structure

```text
test/integration/
├── prompt-to-main-e2e.test.ts       # new 12-01 scripted lifecycle proof [recommended]
├── verify-flake-audit.test.ts       # optional if separate from prompt-to-main test
├── feature-lifecycle-e2e.test.ts    # existing lifecycle seam to reuse or reference
└── harness/                         # existing faux/runtime/store scaffolding

test/helpers/
└── feature-lifecycle-fixture.ts      # likely small helper extensions for merge/main assertions and inbox response

package.json                         # optional script only if planner wants explicit audit command
```

### Pattern 1: Reuse the lifecycle fixture as the base seam

**What:** Instantiate `createFeatureLifecycleFixture()`, script every faux assistant turn in order, seed a feature, run scheduler steps, approve proposal(s), answer one inbox item, and assert state/commit outcomes. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:49-269]

**When to use:** Use this for the 12-01 prompt-to-main proof because it already includes real `LocalWorkerPool` worker execution and real git commits with trailer observations. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:245-270]

**Implementation note:** The fixture defaults `maxConcurrency` to `1` to keep the shared faux response queue linear and deterministic; keep that default unless the plan deliberately scripts independent per-worker queues. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:123-128]

### Pattern 2: Inbox wait in the worker turn, then resume through runtime port

**What:** Script a worker response that calls `request_help`, wait until scheduler/store has an `agent_help` inbox item, call `respondToInboxHelp()`, then drain the harness and continue to submit. [VERIFIED: /home/alpine/vcode0/test/integration/worker-smoke.test.ts:144-209]

**When to use:** Use this to satisfy “answer one inbox item” in 12-01 without pulling in the TUI. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:34-36]

**Pitfall:** Worker faux responses that include `request_help` and `submit` in the same assistant message may pause after help and resume later; tests must not assert result before delivering the help answer. [VERIFIED: /home/alpine/vcode0/test/integration/worker-smoke.test.ts:166-209]

### Pattern 3: Merge-train drain through scheduler integration runner

**What:** Let the lifecycle test reach `awaiting_merge`, then drive scheduler ticks until `beginNextIntegration()` and `runIntegrationIfPending()` process the queued feature. The runner performs rebase, shell verification, agent verification, fast-forward merge, and emits completion. [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/index.ts:197-203] [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/integration-runner.ts:33-90]

**When to use:** Use this for “merge-train drains → main contains expected commits.” If the existing fixture’s worktree layout does not make `simpleGit(cwd).merge([featureBranch, '--ff-only'])` valid, plan a narrow fixture extension rather than rewriting merge train. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:133-158] [ASSUMED]

### Pattern 4: Verify flake audit with isolated five-run loop

**What:** Build five independent verify fixtures or reset tmp dirs per iteration; each iteration scripts `submitVerify({ outcome: 'pass' })`, calls `runtime.verifyFeature(feature, { agentRunId })`, records pass/fail, and asserts `passes === 5`. [VERIFIED: /home/alpine/vcode0/test/unit/agents/verify-contract.test.ts:134-175]

**When to use:** Use this for roadmap criterion 2. Prefer explicit loop output over Vitest retry, because retries hide flake evidence. [CITED: https://vitest.dev/api/test] [ASSUMED]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Mock LLM provider | Custom fake Agent or string parser | `createFauxProvider()` + `fauxAssistantMessage()` + `fauxToolCall()` | Existing pi-ai faux provider drives real Agent/tool loops and is already documented as the integration pattern. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:64-72] |
| Worker subprocess simulation | Hand-emitted `worker_message` sequence for prompt-to-main | `LocalWorkerPool` + `InProcessHarness` | Existing fixture proves real worker runtime, submit, and commit_done behavior without fork flake. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:245-270] |
| Verify protocol | Ad hoc JSON verdicts | `submitVerify` tool via `PiFeatureAgentRuntime.verifyFeature()` | Runtime throws if verify finishes without `submitVerify`; host normalizes issue outcomes. [VERIFIED: /home/alpine/vcode0/src/agents/runtime.ts:278-304] |
| Merge-train FSM | Direct graph state mutation shortcuts | `SchedulerLoop` and/or `MergeTrainCoordinator` | Merge train serialization, re-entry, cap behavior, and persistent graph paths already have fixtures. [VERIFIED: /home/alpine/vcode0/test/integration/merge-train.test.ts:28-198] |
| TUI prompt entry | PTY harness in 12-01 | Scheduler events (`top_planner_requested`, approval events) | TUI golden path is 12-02 and current TUI E2E lane is separate from Vitest. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179] |

**Key insight:** 12-01 should compose existing seams, not create a new mini-orchestrator; custom fakes would reduce confidence exactly where Phase 12 needs integration proof. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:221-230]

## Common Pitfalls

### Pitfall 1: Faux-provider global registration bleed
**What goes wrong:** One test’s faux responses or registered model leaks into another test. [VERIFIED: /home/alpine/vcode0/test/integration/harness/faux-stream.ts:12-21]
**Why it happens:** pi-ai faux provider registration is global. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:64-72]
**How to avoid:** Always `unregister()` in `afterEach`; prefer fixture teardown that stops pool, drains harness, unregisters faux, and deletes tmpdir. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:386-391]
**Warning signs:** Later tests consume unexpected assistant turns or fail on missing model registration. [ASSUMED]

### Pitfall 2: Shared faux queue with parallel worker execution
**What goes wrong:** Multiple workers consume scripted assistant messages in nondeterministic order. [ASSUMED]
**Why it happens:** The lifecycle fixture uses one faux registration for planner, workers, verifier, and summarize. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:197-205]
**How to avoid:** Keep `maxConcurrency: 1` for prompt-to-main proof, or split tests by model/provider queue only if needed. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:123-128]
**Warning signs:** Test passes locally but fails under parallel Vitest or with response-order assertions. [ASSUMED]

### Pitfall 3: Git commit/trailer path only triggers on `git commit` commands
**What goes wrong:** Worker calls `submit()` but scheduler rejects completion because no trailer-valid commit was observed. [VERIFIED: /home/alpine/vcode0/test/integration/feature-phase-agent-flow.test.ts:1968-2121]
**Why it happens:** Existing lifecycle test stages files and uses bare `git commit` so worker trailer injection and `commit_done` emission fire. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:69-72]
**How to avoid:** Pre-create files, script `git add ...`, then script `git commit -m ...`, then `submit`. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:73-123]
**Warning signs:** `task_completion_rejected_no_commit` event or task run enters `retry_await`. [VERIFIED: /home/alpine/vcode0/test/integration/feature-phase-agent-flow.test.ts:2016-2035]

### Pitfall 4: Merge-train test accidentally duplicates 12-03 traceability or 12-02 TUI scope
**What goes wrong:** Planner adds README dry-run, TUI PTY, or requirement green-out tasks into 12-01. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:27-31]
**Why it happens:** Phase 12 success criteria are adjacent in ROADMAP but split into three plans. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:221-236]
**How to avoid:** Add grep-friendly test names and leave handoff notes only; do not edit README/source install docs or `test/integration/tui/**` in 12-01. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:87-93]
**Warning signs:** Planned files include `README.md`, `docs/reference/tui.md`, or `test/integration/tui/`. [ASSUMED]

### Pitfall 5: Runtime cost from full prompt-to-main plus 5-repeat audit
**What goes wrong:** Default `npm run check` becomes slow or flaky. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:80-83]
**Why it happens:** Existing lifecycle E2E tests each allow up to 30 seconds; adding a large scenario plus five verify loops can increase integration runtime. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:49-269]
**How to avoid:** Keep scenario minimal: one feature, one or two tasks, one help wait, one verify pass, one merge drain. If audit is slow, add explicit script and keep default test focused. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:80-83]
**Warning signs:** `npm run test:integration` runtime grows disproportionately or times out on CI. [ASSUMED]

### Pitfall 6: Merge-train cwd/worktree mismatch
**What goes wrong:** `runIntegrationIfPending()` looks for feature worktree under `cwd/worktreePath(featureBranch)` while the fixture also initializes standalone repos under tmp worktree paths. [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/integration-runner.ts:30-34] [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:359-364]
**Why it happens:** Current lifecycle fixture was designed to prove up to `awaiting_merge`, not necessarily fast-forward merge into the tmp root repo. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:228-234]
**How to avoid:** Plan a Wave 0 spike/task to confirm fixture merge layout. If invalid, extend fixture narrowly so feature branch commits are visible to root repo before integration runner merges. [ASSUMED]
**Warning signs:** Rebase reports blocked/missing worktree, or `simpleGit(tmpDir).merge([featureBranch, '--ff-only'])` cannot find branch. [ASSUMED]

## Code Examples

### Deterministic verify audit loop shape

```ts
// Source: /home/alpine/vcode0/test/unit/agents/verify-contract.test.ts and 12-CONTEXT.md
const attempts = 5;
let passes = 0;
const failures: string[] = [];

for (let i = 0; i < attempts; i += 1) {
  try {
    // create fresh tmp projectRoot + feature worktree + runtime/store/sessionStore
    // faux.setResponses([submitVerify(pass), closing text]) for this iteration
    const result = await runtime.verifyFeature(feature, {
      agentRunId: `run-verify-flake-${i + 1}`,
    });
    if (result.ok === true && result.outcome === 'pass') passes += 1;
    else failures.push(`attempt ${i + 1}: ${result.summary ?? 'non-pass'}`);
  } catch (error) {
    failures.push(`attempt ${i + 1}: ${String(error)}`);
  }
}

expect({ passes, attempts, failures }).toMatchObject({ passes: 5, attempts: 5 });
```

### Prompt-to-main test phases to assert

```ts
// Source: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts
// Source: /home/alpine/vcode0/src/orchestrator/scheduler/integration-runner.ts
// 1. top/feature planner run enters await_approval
// 2. approval applies proposal and creates executable tasks
// 3. one worker task emits request_help; respondToInboxHelp answers it
// 4. worker commit_done frames have trailerOk === true
// 5. ci_check and verify feature_phase_completed events exist
// 6. merge train reaches collabControl === 'merged'
// 7. main/root git history contains expected task commit content or merge SHA
```

## State of the Art

| Old Approach | Current Approach | When Changed / Observed | Impact |
|---|---|---|---|
| Hand-emitted worker results | Real `WorkerRuntime` through `LocalWorkerPool` + `InProcessHarness` | Existing Phase 5/7 integration harness | 12-01 should not fake worker closeout except for narrow unit tests. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:33-60] |
| Verify as stub | Verify as pi-sdk agent review using `submitVerify` | Phase 5 and 6 requirements | Flake audit should measure deterministic agent-tool protocol, not shell tests. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:97-113] |
| TUI lane inside Vitest | Separate `@microsoft/tui-test` lane | Current docs | 12-01 must stay in Vitest non-TUI lane. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:160-179] |
| Live provider audit | Faux deterministic audit | Phase 12 context | No live LLM calls in 12-01. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:38-43] |

**Deprecated/outdated:** None identified as deprecated in 12-01 scope. `@microsoft/tui-test` is pre-1.0 and known flaky in this repo, but it is 12-02 scope, not a 12-01 dependency. [VERIFIED: /home/alpine/vcode0/.planning/STATE.md:49-58]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Explicit five-iteration loop is preferable to Vitest `repeats` for audit reporting. | Standard Stack / Pattern 4 | Planner might choose `test.repeats` and lose clear numerator/denominator reporting. |
| A2 | Existing lifecycle fixture may need a narrow merge-layout extension for root-repo fast-forward merge. | Pitfall 6 | Planner may under-scope the merge-train drain task. |
| A3 | Shared faux queue can become nondeterministic if `maxConcurrency` is raised above 1. | Pitfall 2 | Flaky scripted scenario under parallel execution. |

## Open Questions

1. **Should 12-01 add a package script for the flake audit or keep it as a default integration test?**
   - What we know: Context allows an explicit npm script if default `npm run check` would become too slow. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:80-83]
   - What's unclear: Actual runtime after implementation.
   - Recommendation: Start as a focused Vitest test; add `test:verify-flake` only if five repeats materially slow default check. [ASSUMED]

2. **Can `createFeatureLifecycleFixture()` drain merge train into root `main` without extension?**
   - What we know: Existing lifecycle test intentionally stops at `awaiting_merge`/`merge_queued`/`integrating`. [VERIFIED: /home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts:228-234]
   - What's unclear: Whether the fixture’s root repo has the feature branch refs needed by `simpleGit(cwd).merge([featureBranch, '--ff-only'])`.
   - Recommendation: Planner should include Wave 0 investigation or first task to make fixture merge refs explicit. [ASSUMED]

3. **Should summarization be included in prompt-to-main proof?**
   - What we know: Newcomer flow ends with `work_complete` after post-merge summarize or budget-mode shortcut. [VERIFIED: /home/alpine/vcode0/docs/foundations/newcomer.md:199-213]
   - What's unclear: Whether 12-01 acceptance requires `work_complete` or only “main contains expected commits.”
   - Recommendation: Prefer one scripted summarize turn if runtime cost is acceptable; otherwise assert `collabControl='merged'` and document summarize as already covered by existing integration test. [VERIFIED: /home/alpine/vcode0/test/integration/feature-phase-agent-flow.test.ts:1382-1485]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---|---|
| Node.js | Vitest/tsx/npm scripts | yes | v24.13.0 | none needed. [VERIFIED: command -v/node --version] |
| npm/npx | package scripts and optional ctx/docs lookup | yes | 11.9.0 | none needed. [VERIFIED: command -v/npm --version] |
| git | tmp repo/worktree/merge assertions | yes | 2.53.0 | none; git is required for lifecycle proof. [VERIFIED: command -v/git --version] |
| Vitest | integration tests | yes via package | `^4.1.4` installed spec | `npm run test:integration -- <file>` focused run. [VERIFIED: /home/alpine/vcode0/package.json:19-24] |
| Live LLM provider credentials | none | not required | — | faux provider. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:38-43] |
| `@microsoft/tui-test` | 12-02 only | package present | `^0.0.4` | out of 12-01 scope. [VERIFIED: /home/alpine/vcode0/package.json:31-33] |

**Missing dependencies with no fallback:** none identified for 12-01. [VERIFIED: environment probes]

**Missing dependencies with fallback:** live LLM providers are intentionally not needed; faux provider is the fallback/standard. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:64-72]

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Vitest `^4.1.4` installed; latest `4.1.5` verified from npm registry. [VERIFIED: /home/alpine/vcode0/package.json:19-24] [VERIFIED: npm registry] |
| Config file | `vitest.config.ts` exists by package lint target; not read for this research. [VERIFIED: /home/alpine/vcode0/package.json:18] |
| Quick run command | `npm run test:integration -- prompt-to-main-e2e verify-flake-audit` after files exist. [ASSUMED] |
| Full suite command | `npm run check` [VERIFIED: /home/alpine/vcode0/package.json:11-19] |

### Phase Requirements → Test Map

| Req / Criterion | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| Phase 12 SC1 | prompt/planner approval → execute → answer one inbox item → verify → merge train drains → main has expected commits | integration | `npm run test:integration -- prompt-to-main-e2e` | no, Wave 0/Task 1 |
| Phase 12 SC2 | known-good verify path passes 5/5 deterministic repeats | integration or focused script | `npm run test:integration -- verify-flake-audit` or `npm run test:verify-flake` | no, Wave 0/Task 2 |
| Handoff for 12-02 | TUI golden path remains out of scope | documentation in test names/comments only | none | n/a |
| Handoff for 12-03 | grep-friendly evidence names for traceability | test naming/output | `rg "prompt-to-main|verify flake" test/integration` | no, Wave 0/Task 3 |

### Sampling Rate

- **Per task commit:** focused file command for changed tests plus `npm run typecheck`. [ASSUMED]
- **Per wave merge:** `npm run test:integration -- prompt-to-main-e2e verify-flake-audit` and `npm run check`. [ASSUMED]
- **Phase gate:** `npm run check` green before `/gsd-verify-work`. [VERIFIED: /home/alpine/vcode0/CLAUDE.md:11-19]

### Wave 0 Gaps

- [ ] `test/integration/prompt-to-main-e2e.test.ts` — covers Phase 12 SC1. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:225-230]
- [ ] `test/integration/verify-flake-audit.test.ts` or equivalent explicit script — covers Phase 12 SC2. [VERIFIED: /home/alpine/vcode0/.planning/ROADMAP.md:225-230]
- [ ] Possible `test/helpers/feature-lifecycle-fixture.ts` extension — make merge train drain/root `main` assertions reliable. [ASSUMED]
- [ ] Optional `package.json` script only if audit is too costly for default integration lane. [VERIFIED: /home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md:80-83]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---:|---|
| V2 Authentication | no | 12-01 does not add auth flows. [VERIFIED: phase scope] |
| V3 Session Management | no | Uses test-only in-memory session store; no user sessions. [VERIFIED: /home/alpine/vcode0/test/integration/harness/in-memory-session-store.ts] |
| V4 Access Control | no | No authorization surface added. [VERIFIED: phase scope] |
| V5 Input Validation | yes | Do not bypass existing typed tool schemas, scheduler event types, and proposal parsing. [VERIFIED: /home/alpine/vcode0/src/agents/tools/schemas.ts] [VERIFIED: /home/alpine/vcode0/src/orchestrator/scheduler/events.ts] |
| V6 Cryptography | no | No cryptographic code in scope. [VERIFIED: phase scope] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Accidental live LLM/API call from tests | Information disclosure / cost abuse | Register faux provider on configured model slot and do not use live providers. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:64-72] |
| Test writes outside tmp worktree | Tampering | Use existing fixture tmp dirs and worker cwd enforcement; teardown deletes tmpdir. [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:194-205] [VERIFIED: /home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts:386-391] |
| Destructive git operations in tests | Tampering / DoS | Keep scripted worker commands to `git add`, `git commit`, and expected merge/rebase paths; destructive approvals are already separate coverage. [VERIFIED: /home/alpine/vcode0/docs/operations/testing.md:33-41] |

## Sources

### Primary (HIGH confidence)

- `/home/alpine/vcode0/.planning/phases/12-integration-polish/12-CONTEXT.md` — phase boundaries, 12-01/12-02/12-03 split, deterministic faux-provider constraints, flake-audit threshold.
- `/home/alpine/vcode0/.planning/ROADMAP.md` — Phase 12 success criteria and plan split.
- `/home/alpine/vcode0/.planning/STATE.md` — current phase handoff and known TUI/parallel-vitest flakes.
- `/home/alpine/vcode0/docs/operations/testing.md` — integration harness, faux provider, TUI lane split, pitfalls.
- `/home/alpine/vcode0/docs/foundations/newcomer.md` — behavioral prompt-to-main target.
- `/home/alpine/vcode0/test/helpers/feature-lifecycle-fixture.ts` — best deterministic lifecycle harness seam.
- `/home/alpine/vcode0/test/integration/feature-lifecycle-e2e.test.ts` — current planning→execute→ci_check→verify lifecycle proof.
- `/home/alpine/vcode0/test/integration/worker-smoke.test.ts` — request_help/inbox/resume and worker runtime proof.
- `/home/alpine/vcode0/test/integration/feature-phase-agent-flow.test.ts` — top planner, verify, summarize, commit gate integration coverage.
- `/home/alpine/vcode0/test/integration/merge-train.test.ts` — merge-train integration and cap behavior.
- `/home/alpine/vcode0/src/orchestrator/scheduler/integration-runner.ts` — actual merge-train drain logic.
- `/home/alpine/vcode0/src/agents/runtime.ts` — verify-agent implementation.
- npm registry via `npm view` — current package versions.

### Secondary (MEDIUM confidence)

- Vitest official API docs: `https://vitest.dev/api/test` — `retry` and `repeats` options. [CITED: https://vitest.dev/api/test]

### Tertiary (LOW confidence)

- Assumptions A1-A3 in the Assumptions Log; planner should validate during Wave 0.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified from `package.json`, npm registry, and existing tests.
- Architecture: HIGH — based on current source/test seams, especially lifecycle fixture, scheduler, and integration runner.
- Pitfalls: MEDIUM-HIGH — many are directly documented or tested; merge-layout risk is an explicit assumption requiring Wave 0 validation.

**Research date:** 2026-05-02
**Valid until:** 2026-05-09 for fast-moving package versions; repo-specific harness findings valid until significant test/runtime refactor.
