# Comparison with Wave

Snapshot taken on 2026-04-15 from public Wave materials only. This is a high-level product comparison against the public README/docs, not a deep code audit. Worth revisiting as both projects evolve.

## Summary

Wave and gvc0 both live in the AI-assisted software execution space, but the product center is different:

- **Wave** presents as a configurable **AI-as-Code** workflow runner: persona-driven YAML pipelines, explicit contracts/gates, broad operator surfaces, and forge/model adapter flexibility.
- **gvc0** is a more opinionated **DAG-first delivery orchestrator**: persistent milestone/feature/task graph, long-lived feature branches, task worktrees, feature verification, and serialized merge-train integration.

The closest conceptual mapping is approximate rather than exact:

- **Wave pipeline** ≈ a bounded execution plan spanning one of our features or feature phases
- **Wave step** ≈ our task run or feature-phase run, depending on scope
- **Wave run** ≈ our `agent_run` / scheduler-managed execution session

Unlike gsd-2, Wave's public model does not line up cleanly with our `milestone -> feature -> task` hierarchy because Wave is organized around reusable pipeline specs rather than persistent project-graph entities.

## Feature Mapping

| Public Wave feature | Our architecture | Notes |
|---|---|---|
| YAML pipeline DAG with step dependencies | Partial match | We are also DAG-first, but our DAG is persistent project state (`milestone -> feature -> task`), not just one run definition. |
| Parallel execution of independent steps | Yes, similar | Both exploit ready-node parallelism. Wave does it inside pipeline runs; we do it across the scheduler-managed feature/task graph. |
| Persona-scoped agent roles | Partial | We have planner/replanner/task/verify/summarize roles, but not the same operator-facing persona catalog/config surface. |
| Per-step isolated workspace / git worktree | Yes | Close mechanically, but ours is tied to feature branches + task worktrees with explicit branch lifecycle. |
| Approval gates and other gate-step types | Partial | We support `await_approval`, manual takeover, and help/approval waits on `agent_runs`, but not a first-class gate-step DSL. |
| Contract-based handoff validation | Partial | Wave has richer step-local contract vocabulary; we emphasize layered task `submit()`, feature CI, `verifying`, and merge-train checks. |
| CLI + TUI + web dashboard + chat inspection | Partial / missing | We have CLI/TUI, but no documented Wave-equivalent web dashboard, chat control surface, or log/query tooling yet. |
| Forge-native PR / merge automation | Partial / weaker | We rely on internal branch lifecycle + merge train; public docs do not show a comparable broad forge command surface. |
| Multi-backend adapter model | Different | We have explicit model routing and spend normalization; Wave emphasizes adapter flexibility across multiple agent backends/CLIs. |
| Built-in decision/retro/doctor operator tools | Missing | I do not see equivalent product surface documented yet. |
| Retry / rework / rerun controls | Yes, different | Both support retry-style recovery, but we model repair/replanning as persistent work/collaboration state rather than pipeline-local fallback only. |
| Productized workflow library | Partial / different | Wave publicly markets reusable workflows; we are more opinionated around one integrated orchestration model. |

## Where Wave Looks Stronger as Product

1. **Operator surface breadth.** Public docs show CLI, TUI, browser dashboard, chat inspection, logs, decision views, retros, and doctor-style health tooling.
2. **Pipeline language richness.** Wave exposes child pipelines, loops, matrix fan-out, retries, rework, gates, and contracts as first-class YAML product surface.
3. **Guardrail configurability.** Persona/tool rules, sandbox controls, allowed domains, and contract policies are more explicitly operator-configurable.
4. **Ecosystem interoperability.** Public story is broader on forge support and multi-backend adapter coverage.
5. **Workflow packaging.** Wave seems easier to position as a reusable workflow catalog for many repo tasks, not just one orchestration worldview.

## Where gvc0 Remains More Opinionated / Differentiated

1. **Persistent project DAG.** Our milestone/feature/task graph is authoritative long-lived system state, not merely an ephemeral run spec.
2. **Branch lifecycle modeling.** Feature branches, task worktrees, squash-back integration, and serialized merge train are much more explicit.
3. **Work control vs collaboration control.** We model execution progress separately from branch/merge/conflict coordination.
4. **Merge-aware completion semantics.** A feature is not done until collaboration control reaches `merged` and work control reaches `work_complete`.
5. **Repair and replanning as stateful lifecycle.** Feature CI failures, verify failures, and integration conflicts feed same-feature repair/replanning loops rather than only step-local reruns.
6. **Budget governance.** Public gvc0 docs are stronger on per-task/global USD ceilings, normalized token accounting, and routing tiers.

## Where We Still Trail or Differ

1. **Public operator tooling.** No documented gvc0 equivalent yet for Wave-style web dashboard, chat inspection, persisted log queries, retros, or doctor flow.
2. **Step-local contract vocabulary.** Our layered verification is strong, but not as flexible/productized as Wave's contract/gate language.
3. **Persona/product packaging.** Our agent roles exist architecturally, but not as visibly/configurably as Wave's persona-first product story.
4. **External integration breadth.** Broad forge automation and backend adapter interoperability appear stronger in Wave's public product surface.
5. **Ad hoc workflow composition.** Wave is better suited to packaging many reusable YAML workflows; we are more specialized around one DAG-first software-delivery engine.

## Revisit Notes

This comparison is worth revisiting later, especially if we add any of the following:

- web/dashboard or chat-based operator surface
- queryable run logs / decision logs / retros
- first-class approval/gate DSL
- richer contract vocabulary for task/feature handoffs
- broader forge or backend adapter integrations
- reusable workflow templates on top of core DAG orchestration

## Public References

- <https://github.com/re-cinq/wave>
- <https://github.com/re-cinq/wave/blob/main/README.md>
- <https://github.com/re-cinq/wave/blob/main/docs/guide/pipelines.md>
- <https://github.com/re-cinq/wave/blob/main/docs/reference/pipeline-schema.md>
- <https://github.com/re-cinq/wave/blob/main/docs/reference/cli.md>

## Backend Fit Notes

- **Feasible in part:** Wave could plausibly run bounded gvc0 executions like task runs or verify/review phases.
- **Poor full-backend fit:** gvc0's core value is persistent milestone/feature/task state, split work vs collaboration control, and merge-train branch orchestration.
- **Main mismatch:** Wave is strongest as pipeline/run engine; gvc0 needs durable scheduler-owned graph and branch lifecycle state across many runs.
- **Most reasonable shape:** keep gvc0 as source of truth and use Wave, if at all, as a pluggable execution substrate under individual `agent_run`s.
