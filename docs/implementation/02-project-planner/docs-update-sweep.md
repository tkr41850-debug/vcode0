# Docs update sweep

Reference list of documentation files that need updates when this milestone lands. Use this as a checklist after Phases 4–6 merge; the bulk of doc rewrites depends on the architecture being committed code first.

This list was produced by a read-only docs scan against the architectural changes in this milestone. Do not edit docs piecemeal in each phase — bundle the doc updates into one or two commits at the end of the milestone so the documentation transition is atomic.

## Major rewrites

These files describe today's single-planner architecture as canonical and need substantive rewrites to reflect the project / feature planner split.

| File | Sections | Change |
|------|----------|--------|
| `docs/architecture/planner.md` | "Planner: Proposal-Graph Tool Model", tool list, submit/request_help flow, heuristics | Split into project planner vs feature planner/replanner; move milestone/feature/cross-feature topology tools to project scope; define feature-phase tool restrictions and topology escalation via `request_help` |
| `docs/architecture/data-model.md` | "Work Control", `AgentRun` types, state semantics around planning/replanning | Add project-scope runs, document `scope_type='project'` arm, update `discuss`/`plan`/`replan` semantics to feature-local edits only |
| `docs/architecture/persistence.md` | `agent_runs` schema, migrations, state semantics, session authority notes | Document `scope_type='feature_phase' \| 'project'`, project-scope `scope_id` convention, project-run persistence/recovery behavior |
| `docs/architecture/worker-model.md` | Feature-phase execution, crash recovery, `RuntimePort.dispatchRun(...)`, session storage | Extend run lifecycle from task+feature-phase to include persistent project-planner sessions, with no feature worktree requirement; document that project-run dispatch is event-driven from the coordinator and recovery service (not scheduler-tick-driven), so `SchedulableUnit` stays `task \| feature_phase` |
| `docs/architecture/graph-operations.md` | Core Mutations, feature restructuring, orchestrator coordination, schedulable-unit notes | Reassign topology mutation authority to project planner; keep feature planner limited to tasks and intra-feature deps; describe escalation path for topology changes; document apply-time CAS validation for project proposals (no project-scope merge train, no run-start lock — see `docs/concerns/concurrent-project-planner-sessions.md`) |
| `docs/reference/tui.md` | Current Surface, Focus Modes, Composer and Slash Commands, Draft commands, approval/help routing | Add project-planner mode, greenfield auto-entry, explicit composer scope/focus indicator, separate routing rules for project vs feature planner input; replace any `/feature-add --milestone m-1` example wording (the synthetic `m-1` no longer exists post-Phase-5) |
| `docs/operations/verification-and-recovery.md` | Retry/recovery overview, "Help / Approval / Replanning", stuck/replan behavior | Remove "replanner has same tools as planner"; document feature-local replanning plus project-planner escalation and project-scope run recovery |
| `specs/test_stuck_detection_replan.md` | "Replanning mutates the feature graph", approval outcomes | Replace feature-topology mutations with task/intra-feature-only replans and explicit escalation to project planner for topology edits |
| `specs/test_crash_recovery.md` | "Startup recovery sweep...", run/session scenarios | Stop describing recovery as task-only/feature-phase-deferred; add persistent project-planner recovery expectations |

## Minor touch-ups

These files mention the affected concepts in passing and need a sentence or paragraph touch-up.

| File | Sections | Change |
|------|----------|--------|
| `ARCHITECTURE.md` | Core Thesis, Lifecycle Snapshot, Component Map | Mention top-level project planner, empty-project bootstrap, unified run model including project scope |
| `CLAUDE.md` | Project Overview, Architecture, State Model | Summarize project planner role and feature planner restriction |
| `docs/operations/feature-phase-operator-attach.md` | Scope statement, TUI surface, examples | Clarify this doc is feature-phase-only and reconcile with new project-planner mode/composer focus language |
| `specs/test_orchestrator_port_contracts.md` | "FeaturePhaseOrchestrator owns feature-phase agent work" | Add project-planner dispatch/run ownership alongside feature-phase runs |
| `specs/test_agent_run_wait_states.md` | Await-approval / shared run-model wording | Include project-scope waits in the shared `agent_runs` contract |
| `specs/test_feature_verification_replan_loop.md` | Replanner follow-up scenarios | Constrain replan outputs to task/intra-feature edits; topology follow-up must escalate |
| `specs/test_graph_invariants.md` | Dependency/mutation actor wording | Distinguish project-planner cross-feature topology ops from feature-planner local-task ops |
| `docs/implementation/01-baseline/phase-8-planning-branch-bootstrap.md` | Goal/Background/exit criteria | Remove "first feature seeded directly into planning" bootstrap narrative; replace with empty graph + project-planner first run note |
| `docs/architecture/budget-and-model-routing.md` | scope_type assumptions, run-cost accounting | Add `'project'` arm to scope_type; clarify that project-planner runs do not consume task/feature-phase budget envelopes (or document explicitly that they share one — TBD by Phase 4 implementation) |
| `docs/operations/testing.md` | Faux-model harness scope, integration test inventory | Add project-planner-flow test entry; note submit-compliance regression (Phase 8); document plain-text-only faux response helper if added |
| `docs/operations/README.md` | Topic index | Add link to project-planner operator guidance once written; verify the section index still resolves after additions |
| `docs/agent-prompts/README.md` | Index, prompt-source notes | Document that live prompt source is `src/agents/prompts/*.ts` and `docs/agent-prompts/*.md` is the documentation mirror; add `project-planner.md` entry; describe submit-call invariant; describe topology-escalation pattern |
| `docs/agent-prompts/project-planner.md` (new) | All sections | New prose mirror for the project-planner prompt scaffold introduced in Phase 4 |
| `docs/agent-prompts/plan-feature.md` | Tool list, scope statement | Rewrite to drop topology-mutation tool claims; restrict to task DAG and intra-feature deps; add escalation paragraph mirroring `src/agents/prompts/plan.ts` |
| `docs/concerns/planner-write-reservation-accuracy.md` | Scope/terminology | Clarify which planner scope (project vs feature) the concern applies to (or note both); reconcile with project-planner topology authority introduced in Phase 4 |
| `docs/feature-candidates/coordination/in-flight-split-merge.md` | All sections | Rewrite assuming project planner owns split/merge topology; remove implicit feature-planner-driven split language |
| `docs/feature-candidates/runtime/claude-code-harness.md` | Project-planner harness assumption | Rewrite to acknowledge project-planner sessions as a run scope; surface that the harness must work without a feature worktree |
| `specs/test_package_boundary_contracts.md` | Module dependency graph | Add `src/agents/tools/agent-toolset.ts` ↔ `src/agents/tools/planner-toolset.ts` split per Phase 3; add project-planner toolset boundary |
| `specs/test_greenfield_bootstrap.md` (new) | All sections | New spec covering Phase 5's bootstrap-rewrite behavior: greenfield → project-planner session; persisted-but-empty greenfield; existing-project no-spawn |

## Already aligned

- `docs/concerns/concurrent-project-planner-sessions.md` — created during this milestone's design and matches the new direction. Sweep edits applied: terminology fix (`scope=` → `scope_type=`) and an "Implementation Status" section noting today's per-op skip vs Phase 4's whole-proposal CAS.

## Suggested commit grouping

When the architecture has merged through Phase 6 (TUI mode), bundle the doc updates as:

1. `docs(architecture): rewrite planner / data-model / persistence / worker-model / graph-operations for project planner` — the five architecture-doc rewrites.
2. `docs(reference): tui.md project-planner mode and composer focus indicator` — TUI reference.
3. `docs(operations): verification-and-recovery for project-scope runs` — operations doc.
4. `docs(specs): update planner-scope and recovery specs` — the spec rewrites and minor touch-ups.
5. `docs: minor touch-ups for ARCHITECTURE.md, CLAUDE.md, and adjacent files` — everything else.

Do not commit doc updates inside the feature commits of Phases 1–8; the docs lag the code by design so reviewers can compare implementation to documented intent during architecture phases.
