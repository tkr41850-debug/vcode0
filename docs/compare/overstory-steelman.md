# STEELMAN: Agent-Swarm Critiques Applied to gvc0

Snapshot taken on 2026-04-28 from [overstory's STEELMAN.md](https://github.com/jayminwest/overstory/blob/main/STEELMAN.md). 12 well-reasoned critiques of multi-agent code-orchestration swarms, applied to gvc0's documented baseline. This is a structural review of where gvc0's architecture genuinely answers each critique, where it offers a partial answer, and where the critique still bites despite gvc0's documented surface area.

This page is companion to [overstory.md](./overstory.md) (feature-level comparison). Where that page asks *what does gvc0 do that overstory does not*, this page asks the inverse: *where do overstory's published critiques of agent swarms still apply to gvc0's design?*

## Why this lens matters

gvc0 is an agent swarm by overstory's definition: multiple pi-sdk `Agent` child processes running in isolated git worktrees ([worker-model.md](../architecture/worker-model.md)), parallelism as design thesis ([ARCHITECTURE.md](../../ARCHITECTURE.md)), programmatic merge train into `main` ([verification-and-recovery.md](../operations/verification-and-recovery.md)). overstory's STEELMAN — written by the maintainer of the closest architectural analogue in the OSS landscape — is therefore the most credible adversarial review of gvc0's design space.

The interesting question is not *does the critique apply?* but *which architectural answers in gvc0 are real and which are surface area dressed as defense?*

## Verdict at a glance

| # | Concern | Verdict | Strongest gvc0 move |
|---|---|---|---|
| 1 | Compounding error rates | Theater leaning to partial | Multi-tier verification + replanner |
| 2 | Cost amplification | Partial; admitted gap | 3-tier model routing + USD halt |
| 3 | Loss of coherent reasoning | Partial; file-level only | Planner-baked TaskPayload, feature-interface feature |
| 4 | Debugging forensics | Theater | Append-only events + persisted sessions |
| 5 | Premature decomposition | **Real architectural answer** | Discuss → research → plan + HITL proposal-graph approval |
| 6a | Merge conflicts (textual) | **Real architectural answer** | Same-feature locks + two-stage fail-closed |
| 6b | Merge conflicts (semantic) | Partial | Post-rebase `ci_check` |
| 7 | Infrastructure complexity | Partial; honestly admitted | No tmux/daemons; single TS package |
| 8 | False productivity | Partial | Critical-path scheduling + churn warnings |
| 9 | Context window fragmentation | Theater | Worker re-reads source from references |
| 10 | Security and trust surface | Partial; real reductions | No agent mail; write-prehook gate |
| 11 | Expertise illusion | Theater | Replanner agent |
| 12 | Operational risk | Partial; admitted holes | Single-process fail-safe |

Verdict legend:

- **Real architectural answer** — the design encodes an actual structural response; the critique is reduced to a UX or scope problem rather than an architectural one.
- **Partial** — the design contributes a real reduction but the underlying critique still applies to a non-trivial portion of the failure surface.
- **Theater** — the documented defense restates the critique, names more surface area, or catches the failure mode only after the cost it warned about has already been incurred.

## Each concern, scored

### 1. Compounding error rates — Theater leaning to partial

> Three parallel agents at 5% error → ~14.3% aggregate. Conflicting reasonable assumptions surface only at integration boundaries.

gvc0's documented defense is a four-tier verification stack: task `submit()`, feature `ci_check`, agent-level `verifying` (spec compliance review), then post-rebase `ci_check` inside the integration executor. All verify-shaped failures route through `replanning` with a typed `VerifyIssue[]` discriminated by `verify | ci_check | rebase` source ([verification-and-recovery.md](../operations/verification-and-recovery.md)).

The defense overstates what those tiers do. Pre-verify and post-rebase `ci_check` run the same `verification.feature` config flanking a rebase — that is one filter run twice, not two independent filters. The agent-level `verifying` phase is itself a fallible LLM call — `AgentRunPhase` lists it as just another phase ([data-model.md](../architecture/data-model.md)) — so it can produce false-positive sign-offs at the same base error rate the critique posits. Replan-loop thresholds default to **3** per source and **6** aggregate ([warnings.md](../operations/warnings.md)); these are warnings, not gates. [Concern: Merge-Train Re-entry Cap](../concerns/merge-train-reentry-cap.md) openly admits re-entry is uncapped and warnings "fire but do not gate." The critique survives to the extent that semantic conflicts can compile cleanly past `ci_check` and pass spec review, then resurface later as field bugs.

### 2. Cost amplification without proportional value — Partial; admitted gap

> Coordination overhead consumes tokens. Real example: 20-agent 6-hour swarm = 8M tokens / $60; single agent 8 hours = 1.2M tokens / $9. 2-hour speedup cost $51.

The defense is real on paper: 3-tier model routing (heavy/standard/light) with `light` for verify and summarize phases, `escalateOnFailure` and `budgetPressure` policies, global and per-task USD ceilings with halt, and the `budget` token profile that skips summarizing ([budget-and-model-routing.md](../architecture/budget-and-model-routing.md)).

The defense is undercut by what gvc0 itself documents:

- Baseline routing config ships **disabled** with all three tiers pointing at the same model — the savings are potential, not actual ([worker-model.md](../architecture/worker-model.md)).
- [Concern: Worker Runaway](../concerns/worker-runaway.md) explicitly admits *"no wall-clock budget, no progress-idle timeout, no cost-based cutoff on a running worker."* The per-task USD cap is aspirational at baseline.
- [Concern: Summarize Retry Loop](../concerns/summarize-retry-loop.md) admits a phase that retries forever on flat 1-second backoff with no cap.
- [Concern: Verification and Repair Churn](../concerns/verification-and-repair-churn.md) admits verification *"may dominate runtime and token/cpu cost before the DAG scheduler's parallelism benefits fully pay off."*

The phase stack is also genuinely larger than a single agent's loop: discuss, research, plan, execute, ci_check, verify, awaiting_merge, summarize per feature ([data-model.md](../architecture/data-model.md)), plus replan loops. The critique's $51-for-2hr-speedup math is exactly the failure mode gvc0 has not yet defended against in baseline.

### 3. Loss of coherent reasoning — Partial; file-level only

> Naming drift (`userId` vs `user_id` vs `uid`), duplicated utilities, conflicting architectural assumptions, impedance mismatches. Tests don't catch architectural drift.

Planner-baked `TaskPayload` carries `objective`, `scope`, `expectedFiles`, `references`, `outcomeVerification`, plus `featureObjective` and `featureDoD` per task ([planner.md](../architecture/planner.md)). The planner can split shared contracts into a dedicated feature-interface feature when downstream features depend on a stable shape. `KNOWLEDGE.md` and `DECISIONS.md` are append-only project conventions cited via task `references`.

These are real answers to *file-level* contention. The deeper critique operates *below* file granularity and *above* the verify text-match: naming drift across sibling tasks, duplicated utilities in disjoint files, impedance mismatches at API boundaries. Nothing in `data-model.md` or `planner.md` constrains semantic API shape across tasks dispatched in parallel from the feature frontier. Each per-feature planner is its own agent session with its own context — cross-feature naming consistency emerges only from `KNOWLEDGE.md`/`DECISIONS.md` text drift and post-rebase CI mechanics. [Concern: Planner Write-Reservation Accuracy](../concerns/planner-write-reservation-accuracy.md) admits reservations are *"planner-predicted metadata… still guesses made before execution begins."* Tests catch behavior, not vocabulary.

### 4. Debugging forensics — Theater

> Bugs require reconstructing across multiple worktrees, mail threads, parallel timelines. Git blame doesn't work across worktrees. Debugging tax often exceeds parallelism gains.

The documented defense — append-only `events` table, persistent SQLite at `.gvc0/state.db`, per-run `agent_runs` rows with `token_usage` and `session_id`, retained worktrees until merge, persisted session transcripts under `.gvc0/sessions/`, TUI feature detail views — describes *more* forensic surface, not less.

Worse: task worktrees squash-merge into the feature branch ([worker-model.md](../architecture/worker-model.md)), destroying per-task incremental commit history. After a feature lands, `git blame` on `main` shows the squash author for the whole feature, not the original task agent's commits. The TUI is not a substitute for `git log -p` across N task transcripts × M features × K replan attempts × CI runs. The critique survives intact: gvc0's persistence makes forensics *possible* but not *cheap*, and the cheapness was the point.

### 5. Premature decomposition — Real architectural answer

> Decomposition before exploration cascades costs. Wrong abstraction layer, missed dependencies, overlapping concerns.

This is gvc0's strongest defense. The lifecycle runs `discussing → researching → planning` before `executing` ([data-model.md](../architecture/data-model.md)). `discussing` is a *blocking modal* in the TUI awaiting user answers. The planner builds a temporary proposal-graph via tool calls; `submit()` enters `await_approval`; the authoritative graph mutates only after the user explicitly approves ([planner.md](../architecture/planner.md)). The replanner exists exactly for verify-failure recovery when decomposition turns out wrong, and proposes graph mutations that the user approves before they apply.

The critique is reduced from "the architecture forces premature decomposition" to "humans approving wrong plans," which is a UX/judgment problem rather than an architectural one.

Caveat: the `budget` token profile skips both `discussing` and `researching` ([data-model.md](../architecture/data-model.md)), restoring exactly the failure mode the critique describes. The architectural answer is real only outside budget mode.

### 6a. Merge conflicts (textual) — Real architectural answer

> Multiple agents modifying shared files (`types.ts`, `schema.sql`, configs, fixtures) produces inevitable conflicts.

Same-feature locks are layered: planner reservations are predictive; the write-prehook claims an active path lock on first write through the orchestrator; actual git overlap is ground truth ([conflict-coordination.md](../operations/conflict-coordination.md)). When the prehook denies a claim, the same `ConflictCoordinator` entry points used by the preventive scheduler scan fire, so reactive and preventive paths produce identical downstream behavior ([worker-model.md](../architecture/worker-model.md)). Same-feature handling is two-stage and explicitly *fail-closed*: mechanical rebase first, then agent reconciliation in the real conflicted worktree with injected context — no auto-pick `ours`/`theirs`, no destructive resets.

Cross-feature overlap uses per-feature blocking (`runtimeBlockedByFeatureId`) with a primary/secondary policy keyed off explicit-dependency precedence and merge-proximity rank ([conflict-coordination.md](../operations/conflict-coordination.md)). On primary merge, the secondary feature branch rebases onto updated `main` before any secondary task resumes; rebase failure routes through `replanning` with `source: 'rebase'`.

This is a substantive policy, not theater. gvc0's own [overstory comparison](./overstory.md) names this as one of the strongest moats.

### 6b. Merge conflicts (semantic) — Partial

> Semantic conflicts (one agent adds required field, another adds code that doesn't provide it) are worse than textual.

The reservation system tracks file paths only. Two tasks editing *disjoint* files can still produce a type error or semantic mismatch at integration. Post-rebase `ci_check` is the catch — but it runs only after parallel work has already been burned. Agent-level `verifying` checks feature spec compliance, but spec text rarely encodes cross-task API contracts at the granularity needed.

This is a partial answer rather than theater because post-rebase `ci_check` does prevent semantic conflicts from landing on `main`. The critique still bites on tokens spent before the catch fires.

### 7. Infrastructure complexity — Partial; honestly admitted

> tmux + worktrees + SQLite mail + watchdog + hooks + dashboard. Each is a failure mode you must maintain.

gvc0's surface is genuinely smaller than overstory's: single TS package, child processes (no tmux), NDJSON over stdio (no custom transport), `simple-git` directly, single SQLite database, no daemons, no PreToolUse/PostToolUse hooks beyond the write-claim. [overstory.md](./overstory.md) itself admits overstory has "conceptual minimalism" and gvc0's three-axis state model is harder to reason about.

The framing "no tmux, no daemons" is true but selective. gvc0's actual moving parts: scheduler with frontier/priority/retry/conflict-coordinator, integration executor with marker rows + reconciliation, replanner agent, planner agent, verify agent, summarize agent, proposal-graph approval flow, steering ladder with four tiers, two state axes (work_control + collaboration_control) plus run-state, write-prehook lock registry, session store, file session-store backing, scope-aware `RuntimePort.dispatchRun`. The IPC surface alone has 18+ message variants ([worker-model.md](../architecture/worker-model.md)). The critique is not refuted; gvc0 has different complexity, traded inwards from operational surface to model surface.

### 8. False productivity — Partial

> Green checkmarks ≠ output. Coordination theater inflates dashboards but lowers code-per-hour.

Critical-path-aware scheduling (sort key #3 in priority order, [data-model.md](../architecture/data-model.md)) and replan-loop warnings (default thresholds 3 per source, 6 aggregate, [warnings.md](../operations/warnings.md)) plus feature churn warnings are real signals.

The metric problem persists. Warnings track duration, ejections, replan counts — all *coordination* metrics. There is no implementation throughput metric tied to merged-to-`main` code volume. A green dashboard with all features in `awaiting_merge` looks identical to one with all features actually delivering. Cost-vs-output ratio has no surfacing in `warnings.md` or `data-model.md`. The 6-aggregate replan-loop threshold means the system can spend a lot of tokens before warning — and the warning is advisory, not a halt.

### 9. Context window fragmentation — Theater

> Task specs are lossy compressions of intent. File scope hides related code. Information transfer between agents loses nuance.

The defense — planner-baked TaskPayload, references as file pointers, worker re-reads source — repackages the critique. `TaskPayload` ([worker-model.md](../architecture/worker-model.md)) carries `objective?`, `scope?`, `references?`, `dependencyOutputs?` — every field optional, every field a lossy summary of planner reasoning. `DependencyOutputSummary` is literally `{ taskId, summary, filesChanged }` — a paragraph blob describing what a sibling agent did. Workers do not see the discuss or research outputs unless cited.

The execute-task prompt itself surfaces the impedance problem rather than solving it: *"Task plan is authoritative contract… local code reality wins over stale assumptions"* ([execute-task.md](../agent-prompts/execute-task.md)). That is guidance, not mechanism. The worker can re-read code but cannot re-derive the planner's reasoning, alternatives considered, or rejected approaches. The critique survives.

### 10. Security and trust surface — Partial; real reductions

> More autonomous processes with write access. Mail in plaintext. Hooks eval bash. Agents read each other's worktrees.

Genuine reductions: no inter-agent mail system, no shared tmux, write-prehook orchestrator gate on file edits ([worker-model.md](../architecture/worker-model.md)), no PreToolUse/PostToolUse user-bash hooks, single SQLite file with no separate mail database. Replanner proposals require human approval before they mutate the authoritative graph.

Surface that remains: child workers run in worktrees that are peer directories under `.gvc0/worktrees/` — filesystem read access across worktrees is not gated; the prehook only gates writes. Workers run pi-sdk `Agent` with shell tools implied by `verification.task.command` running arbitrary `npm`/`eslint`/`pytest`/etc. SQLite at `.gvc0/state.db` is plaintext. The `append_knowledge` and `record_decision` tools write to `KNOWLEDGE.md`/`DECISIONS.md` ([knowledge-files.md](../reference/knowledge-files.md)) — that is an inter-agent communication channel; a compromised worker can plant misleading "knowledge" that influences future planner runs. The reduction is real; "no security surface" is not the claim that should be made.

### 11. Expertise illusion — Theater

> Right approach often discovered DURING implementation. Builder either implements literal spec (worse design) OR improvises (loses planning benefit) OR coordinates back (overhead).

The replanner is the documented answer ([verification-and-recovery.md](../operations/verification-and-recovery.md)), but it triggers *only after verify-shaped failure* — i.e., after parallel implementation has already burned tokens. Stuck detection at 5 consecutive failures ([verification-and-recovery.md](../operations/verification-and-recovery.md)) is post-hoc, not preventive. The worker prompt's *"minor local adaptation is allowed; fundamental plan invalidation is blocker"* ([execute-task.md](../agent-prompts/execute-task.md)) is exactly the critique's three options surfaced as guidance: keep going (literal spec), adapt locally (improvise), or blocker-flag (coordinate back).

The architectural premise that exploration and implementation can be cleanly separated is encoded in `discussing → researching → planning → executing`. That is exactly what the critique says doesn't survive contact with deeply interconnected codebases. [Concern: Verification and Repair Churn](../concerns/verification-and-repair-churn.md) admits the failure mode by name. Critique survives.

### 12. Operational risk — Partial; admitted holes

> Runaway spawning, retry loops, 24/7 background spend. Single-agent workflow is fail-safe; swarms need active monitoring.

Single-process fail-safe is real: orchestrator owns child processes; close it and everything stops. Parallelism cap defaults to CPU count or provider rate limit ([worker-model.md](../architecture/worker-model.md)). Exponential backoff to one week with jitter ([verification-and-recovery.md](../operations/verification-and-recovery.md)). `crashloop_backoff` attention attribute. Stuck detection. Budget halt on global ceiling.

The admitted holes are documented in [docs/concerns/](../concerns/README.md):

- [Worker Runaway](../concerns/worker-runaway.md) — no wall-clock cap, no progress-idle timeout, no cost-based cutoff on a running worker.
- [Summarize Retry Loop](../concerns/summarize-retry-loop.md) — flat 1-second backoff, no cap, retries forever on deterministic failure.
- [Merge-Train Re-entry Cap](../concerns/merge-train-reentry-cap.md) — `mergeTrainReentryCount` uncapped.

Exponential backoff with `maxDelayMs: 7 * 24 * 60 * 60 * 1000` means a crashlooping run can sit accumulating spend over days. `crashloop_backoff` is an `attention` flag, not a halt. Provider-rate-limit retries happen *outside* USD accounting until the retry burns through. The own-concerns directory is the strongest evidence the critique still applies in baseline.

## Where gvc0 has real architectural answers

Two concerns reduce to non-architectural problems in gvc0's design:

- **Premature decomposition (#5).** Discuss → research → plan with blocking discuss modal and HITL proposal-graph approval is structural. The critique becomes a UX/judgment problem rather than an architectural one. Caveat: budget mode skips this guard.
- **Textual merge conflicts (#6a).** Same-feature lock layering plus two-stage fail-closed handling plus cross-feature primary/secondary policy is a substantive policy, not theater.

These are the parts of gvc0's architecture worth borrowing into other agent-orchestration systems even if the rest is not adopted.

## Where the critique still bites

Five concerns are largely theater in baseline — surface area dressed as defense, with the documented failure mode catching the cost only after it has been incurred:

- **Debugging forensics (#4).** Squash-merge destroys per-task commit history; persistence makes forensics possible but not cheap.
- **Context window fragmentation (#9).** TaskPayload is a lossy summary the worker cannot re-derive; "re-read source" is guidance, not mechanism.
- **Expertise illusion (#11).** Replanner triggers only after parallel cost has burned; the architectural premise of clean exploration/implementation separation is exactly the assumption STEELMAN denies.
- **Compounding errors (#1).** Multi-tier verification is partly redundant boundary-checking around a rebase; semantic conflicts can pass all gates.
- **False productivity (#8).** Coordination metrics tracked, output throughput not — the dashboard problem persists in different shape.

## The concerns directory as confession list

gvc0's own [docs/concerns/](../concerns/README.md) is doing real work as a public confession list. STEELMAN's critiques map directly onto admitted gaps:

| STEELMAN concern | gvc0 confession |
|---|---|
| #2 Cost amplification | [Worker Runaway](../concerns/worker-runaway.md) — no wall-clock or cost cutoff |
| #2 Cost amplification | [Verification and Repair Churn](../concerns/verification-and-repair-churn.md) — verification may dominate cost |
| #3 Coherence loss | [Planner Write-Reservation Accuracy](../concerns/planner-write-reservation-accuracy.md) — reservations are guesses |
| #12 Operational risk | [Summarize Retry Loop](../concerns/summarize-retry-loop.md) — flat 1s backoff, retries forever |
| #12 Operational risk | [Merge-Train Re-entry Cap](../concerns/merge-train-reentry-cap.md) — uncapped re-entry |

The baseline has not yet defended against these gaps. They are intentionally deferred. That is honest engineering, but it also means the STEELMAN cost/operational critiques apply directly until they are closed.

## When this design pays off, when it does not

gvc0's design pays off when work is *genuinely DAG-decomposable*:

- Clear feature boundaries with low cross-feature semantic coupling.
- Contracts that the planner can stabilize early via the feature-interface feature pattern.
- File-level conflict surface dominates over semantic-conflict surface.
- Feature throughput matters more than dollars-per-feature.
- Operator availability for HITL plan approval is real (not budget mode).

It will burn money in deeply-interconnected refactors where:

- The right approach is discoverable only during implementation.
- Cross-feature semantic coupling dominates (shared type evolution, shared protocol shape).
- Verification cost dominates implementation cost — the [Verification and Repair Churn](../concerns/verification-and-repair-churn.md) regime.
- Single-agent sequential work would have completed the same task at a fraction of the spend.

These are the same boundaries STEELMAN draws between *narrow but real* swarm use cases and the day-to-day engineering work that should not use a swarm.

## Recommended follow-up reading

In rough order of payoff:

1. **Close the admitted concerns.** [Worker Runaway](../concerns/worker-runaway.md) and [Summarize Retry Loop](../concerns/summarize-retry-loop.md) are the highest-payoff fixes for STEELMAN concerns #2 and #12. A wall-clock cap and a summarize retry cap turn theater into partial defense.
2. **Add output-throughput metrics.** [Warnings](../operations/warnings.md) tracks coordination signals only. A merged-to-`main` lines-per-token-spent ratio per feature, surfaced in TUI, partially answers concern #8.
3. **Document the cross-task semantic conflict gap.** Concern #6b is partial today; either accept that as the design boundary and document it, or describe a planned mitigation (cross-task type-shape contracts, shared interface review before parallel implementation).
4. **Treat the discuss/research budget-mode skip as a known regression.** The strongest architectural defense (#5) is conditional on non-budget mode. Either document this as an explicit trade-off in [budget-and-model-routing.md](../architecture/budget-and-model-routing.md) or add a "minimum viable discuss" path that survives budget mode.
5. **Read overstory's hooks and watchdog source.** STEELMAN cites these as failure modes; cross-checking against gvc0's "no daemons, no hooks" framing will sharpen the [overstory.md](./overstory.md) comparison.

## Public references

- [overstory STEELMAN.md](https://github.com/jayminwest/overstory/blob/main/STEELMAN.md)
- [overstory repo](https://github.com/jayminwest/overstory)
- Companion: [overstory feature-level comparison](./overstory.md)
- Companion: [Landscape Overview](./OVERVIEW.md)

## Revisit notes

Worth revisiting after:

- Any of the [concerns](../concerns/README.md) cited above are closed — that flips the affected verdict from theater to partial or partial to real.
- A throughput metric ships alongside the existing churn warnings — that closes the #8 gap.
- A cross-task semantic-contract mechanism appears in [planner.md](../architecture/planner.md) — that closes the #6b gap.
- overstory publishes a primary/secondary cross-feature policy or a wall-clock worker cap — those would update the comparison baseline.
- Real production runs accumulate enough data to confirm or falsify the [Verification and Repair Churn](../concerns/verification-and-repair-churn.md) prediction.
