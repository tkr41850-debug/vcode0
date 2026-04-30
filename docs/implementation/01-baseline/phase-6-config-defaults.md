# Phase 6 — Config defaults & generation

## Goal

Make config defaults come from one place, and make first-run `.gvc0/config.json` generation use that same source of truth. Keep current sparse-config semantics: generate only safe persisted defaults on disk, while runtime still derives effective defaults for omitted optional sections.

This phase is cleanup with behavioral guardrails, not config-surface expansion. Main risk is changing meaning of omitted sections while centralizing helpers.

## Scope

**In:** centralizing default model id, model-routing fallback shape, warning thresholds, and generated-config builder in `src/config.ts`; routing the three independent routing-fallback shapes (config.ts, runtime/routing, agents/runtime.ts) through one helper; preserving sparse first-run generation semantics.

**Out:** new persisted config surface (no writing `budget`, `modelRouting`, or `verification` to disk); TUI `/init` or CLI flag for config bootstrap; `harness.kind = 'claude-code'` runtime wiring; export/materialize command; planner-prompt behavioral changes for omitted `verification.feature`.

## Background

Verified state on `main`:

- **Config file already auto-creates, but only through loader side effect**: `JsonConfigLoader.load()` in `src/config.ts:74-99` resolves `.gvc0/config.json`, creates parent dir, and on `ENOENT` writes `cloneDefaultConfig()` output. `composeApplication()` in `src/compose.ts:44+` triggers this via `new JsonConfigLoader().load()` at `:48` (not `:346-350` — that block is `ensureRuntimeDirs()`).
- **Persisted defaults and runtime defaults are split**: persisted startup defaults live in `src/config.ts:62-68` and `src/config.ts:102-107`, but runtime fallbacks also live in `src/runtime/routing/index.ts:22-38`, `src/compose.ts:42,223`, `src/orchestrator/scheduler/index.ts:111-130`, and prompt/runtime fallback logic in `src/agents/runtime.ts:541-544,582-598`. **Three independent routing-fallback shapes exist**: (1) `routingConfigOrDefault()` in `src/runtime/routing/index.ts` (used by task-worker path: `worker-pool.ts`, `dispatch.ts`, `recovery-service.ts`), (2) the inline `ModelRoutingConfig`-shaped object in `src/agents/runtime.ts:587-597` (used by feature-phase agent runtime — does NOT call `routingConfigOrDefault`), (3) the persisted-default constants in `src/config.ts`. Step 6.2 must reconcile (1) and (2) by routing the feature-phase agent through the same centralized helper.
- **Default model id is duplicated**: `src/compose.ts:42` and `src/runtime/routing/index.ts:20` both hardcode `'claude-sonnet-4-6'`.
- **Warnings already have one partial canonical default path**: `defaultWarningConfig()` in `src/config.ts:42-54` backs both generated config and normalization fallback (`src/config.ts:130-132`), but scheduler still carries inline fallback literals in `src/orchestrator/scheduler/index.ts:111-130`.
- **Verification has one semantic edge**: missing `verification.feature` and explicit `verification.feature.checks: []` are not equivalent for planner prompt text. `src/agents/runtime.ts:541-544` falls back to `'No feature verification checks configured.'` only when config section is absent; explicit empty array produces empty string, then prompt renderer drops that section in `src/agents/prompts/shared.ts:32-39,83-99`.
- **Model-routing defaults already have useful runtime shape, but not config-file ownership**: `routingConfigOrDefault()` in `src/runtime/routing/index.ts:22-38` builds fallback routing config when `modelRouting` is omitted. Writing that whole shape into generated config would pin current model ids on disk instead of inheriting future code defaults.
- **Harness config is parsed ahead of runtime wiring**: `src/config.ts:246-313` supports `harness.kind = 'claude-code'`, but `src/compose.ts:289-292` still hardcodes `PiSdkHarness`. So generated defaults must not imply `claude-code` path is active.
- **Current generated file is intentionally sparse**: test coverage in `test/unit/config.test.ts:12-35` proves missing-file bootstrap writes only `tokenProfile`, `warnings`, and `harness`.

## Steps

Ships as **3 commits**, in order.

---

### Step 6.1 — Centralize config default ownership in `src/config.ts`

**What:** make `src/config.ts` single owner of config default values and default-building helpers. Split ownership into two explicit layers:

- **persisted startup defaults** — what first-run generation writes to `.gvc0/config.json`
- **effective/runtime defaults** — values consumers use when optional sections are absent

Pull duplicated default constants and fallback shapes under this module so downstream code imports helpers instead of re-declaring values.

**Files:**

- `src/config.ts` — replace `cloneDefaultConfig()` with named builders that make ownership obvious, e.g. a persisted-default builder for startup file generation and runtime/effective-default helpers for consumers. Keep `defaultWarningConfig()` as canonical warning default source. Add centralized ownership for default model id currently duplicated elsewhere. Add centralized helper for model-routing fallback shape while preserving current behavior from `routingConfigOrDefault()`.
- `src/runtime/routing/index.ts` — keep public behavior of `routingConfigOrDefault()` unchanged, but source fallback values from `src/config.ts` instead of owning them locally.
- `src/compose.ts` — remove local `DEFAULT_MODEL_ID` constant and import centralized default-model helper/value from `src/config.ts`.
- `src/core/types/config.ts` — no schema expansion expected in this step; touch only if helper return types need small export cleanup.

**Tests:**

- `test/unit/config.test.ts` — add focused assertions for centralized default builders so persisted defaults and effective defaults both have direct unit coverage.
- `test/unit/compose.test.ts` — update expectations only if helper names/exports change; behavior should remain same.
- Add or extend a routing-focused unit test if needed to prove `routingConfigOrDefault()` output is byte-equivalent before/after helper move.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify default centralization: (1) `src/config.ts` is now sole owner of default model id and model-routing fallback shape; `src/compose.ts` and `src/runtime/routing/index.ts` no longer hardcode those values; (2) persisted-startup defaults and effective/runtime defaults are distinct helpers, not one overloaded builder that accidentally materializes optional sections on disk; (3) `routingConfigOrDefault()` behavior is unchanged for missing `modelRouting`; (4) no config-type surface was expanded as part of the refactor. Under 300 words.

**Commit:** `refactor(config): centralize default ownership`

---

### Step 6.2 — Refactor consumers to use centralized helpers without changing sparse-config semantics

**What:** replace inline fallback literals in config consumers with centralized helpers from `src/config.ts`, but preserve today’s behavior when optional sections are absent.

Key rule: omitted optional config must keep meaning it has today. This phase centralizes fallback ownership; it does **not** silently reinterpret missing `verification`, `modelRouting`, or `budget` sections.

**Files:**

- `src/orchestrator/scheduler/index.ts` — replace inline warning/budget fallback literals with centralized helpers where defaults are already established. Preserve current values (`warnAtPercent ?? 80`, `globalUsd ?? 1`, warning thresholds from `core/warnings`). Do not invent new persisted config surface here.
- `src/agents/runtime.ts` — keep current planner prompt fallback behavior when `verification.feature` is absent. In particular, do **not** rewrite logic so explicit `checks: []` becomes equivalent to absent verification unless intentionally changing planner prompt text.
- `src/runtime/routing/index.ts` — keep current sparse-config behavior for omitted `modelRouting`, including routing-disabled default and ceiling/tier fallback shape.
- `src/compose.ts` — consume centralized default-model helper/value when wiring feature-phase agent runtime.
- `src/orchestrator/services/recovery-service.ts` and any other fallback consumer touched by helper extraction — update imports if needed, but preserve runtime behavior.

**Tests:**

- `test/unit/orchestrator/scheduler-warnings.test.ts` — verify warning emission still uses same thresholds after helper migration.
- `test/unit/agents/runtime.test.ts` — add or extend case proving planner prompt behavior is unchanged when `verification` is absent.
- `test/unit/config.test.ts` — add absent-vs-present regression coverage for verification helper behavior if needed.
- Run any touched routing/recovery unit tests that currently lock missing-config behavior.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify consumer refactor: (1) omitted `verification.feature` still yields planner fallback text `'No feature verification checks configured.'`; explicit empty `checks: []` was not silently collapsed into same behavior; (2) scheduler warning/budget defaults are unchanged after helper extraction; (3) omitted `modelRouting` still behaves exactly like current `routingConfigOrDefault()` output; (4) no consumer now writes or materializes optional config sections as side effects. Under 350 words.

**Commit:** `refactor(config): route consumers through centralized defaults`

---

### Step 6.3 — Keep generation loader-owned, but drive it from centralized builders

**What:** keep first-run config generation in `JsonConfigLoader.load()`, but make missing-file generation use centralized persisted-default builder instead of a hand-built clone. Add internal helper that materializes effective config from centralized defaults plus overrides for tests and future export flows, without changing startup file semantics today.

Startup-generated config stays sparse. Do **not** fully materialize optional sections into `.gvc0/config.json` in this phase.

**Files:**

- `src/config.ts` — in `JsonConfigLoader.load()` missing-file branch, replace current `cloneDefaultConfig()` usage with centralized persisted-default builder. Add internal helper for materializing effective config from centralized defaults plus optional overrides; use it for tests or future export/generation needs, but do not expose a new user-facing command in this phase.
- `test/unit/config.test.ts` — keep missing-file bootstrap expectation sparse: generated file should still contain only canonical persisted defaults (`tokenProfile`, `warnings`, `harness`). Add direct coverage for materialize-effective-config helper.
- `test/unit/compose.test.ts` — confirm `composeApplication()` still bootstraps `.gvc0/config.json` via loader path.
- `docs/architecture/*` or other docs — no doc updates required in this phase beyond implementation doc itself unless tests reveal existing config docs now contradict preserved sparse behavior.

**Tests:**

- `test/unit/config.test.ts` — assert first-run generated file remains sparse and stable.
- `test/unit/compose.test.ts` — assert startup bootstrap path still creates `.gvc0/config.json`.
- Run any config-adjacent tests that exercise `JsonConfigLoader.load()`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify config generation: (1) first-run `.gvc0/config.json` generation is still loader-owned inside `JsonConfigLoader.load()` — no TUI or CLI init surface was added; (2) generated file remains sparse and does not start materializing `budget`, `modelRouting`, or `verification`; (3) centralized persisted-default builder and effective-config materializer do not drift from one another in tested fields; (4) `harness.claudeCode.*` is not emitted as meaningful generated config while `src/compose.ts` still hardcodes `PiSdkHarness`. Under 300 words.

**Commit:** `refactor(config): generate startup config from centralized defaults`

---

## Phase exit criteria

- All three commits land in order.
- `npm run verify` passes.
- First-run startup still creates `.gvc0/config.json` automatically.
- Generated startup config remains sparse and matches current semantics: only canonical persisted defaults are written.
- Runtime fallback behavior is unchanged for omitted optional sections, especially:
  - omitted `modelRouting`
  - omitted `verification.feature`
  - omitted `budget`
- Run final review subagent across all three commits to confirm there is now one default-owning module, generation still belongs to loader/startup, and no optional-section semantics drifted during refactor.

## Notes

- **Recommended ship order:** `5 → 6 → 1 → 2 → 3 → 4`. Phase 5 stays first because it is foundational happy-path work. Phase 6 is good early cleanup because later phases read or extend config-adjacent defaults and benefit from one source of truth.
- **Non-goal: full config materialization.** This phase deliberately does **not** write `budget`, `modelRouting`, or `verification` into generated startup config. `verification.feature.checks: []` changes planner prompt behavior; `modelRouting` defaults are better inherited from code than pinned on disk; `budget.perTaskUsd` lacks clear runtime owner; `harness.claudeCode.*` is parsed ahead of runtime wiring.
- **Non-goal: command surface.** Do not move config generation into TUI `/init`, CLI flags, or another explicit command. Current repo pattern already treats config bootstrap as loader/startup work.
- **Future follow-up unlocked by this phase:** once defaults are centralized, repo can add explicit export/materialize command later if wanted, but that should be separate product decision, not hidden behavior change in baseline startup.
- **Downstream phases add new config fields.** Phase 1 step 1.4 adds `workerHealthTimeoutMs`; Phase 1 step 1.5 adds a `retryPolicy` sub-object; Phase 5 step 5.2 adds `maxSquashRetries`. Each downstream phase is responsible for adding its new field's default to the centralized builder Phase 6 establishes — do not let later phases re-introduce inline literal fallbacks elsewhere in the tree. The Phase 1 / Phase 5 review subagents should grep for new `??` fallbacks in non-config files and route them through Phase 6's helpers.
