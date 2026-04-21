# Feature Candidate: Structured Feature-Phase Outputs

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

`features.discuss_output` and `features.research_output` persist the output of the discuss and research feature phases as raw markdown blobs. Downstream phases consume them as opaque context blocks in prompt rendering. Individual decisions, findings, risks, and open questions are not addressable as discrete records.

```ts
interface Feature {
  // ...
  discussOutput?: string;    // markdown produced by submitDiscuss
  researchOutput?: string;   // markdown produced by submitResearch
}
```

Task-side `references` stays `string[]` — free-text pointers (file paths, quoted decisions, URLs) with no schema discrimination.

## Candidate

Replace raw markdown with typed envelopes mirroring prompt sections 1:1, plus a discriminated `Reference` union for cross-phase backlinks.

```ts
type Reference =
  | { kind: 'file';      path: string;      lineAnchor?: string;  note?: string }
  | { kind: 'knowledge'; entryId: string;                         note?: string }
  | { kind: 'decision';  featureId: FeatureId; bulletId: BulletId; note?: string }
  | { kind: 'finding';   featureId: FeatureId; bulletId: BulletId; note?: string }
  | { kind: 'url';       url: string;                             note?: string };

interface Bullet {
  id: BulletId;
  text: string;
  rationale?: string;
  supersedes?: BulletId;    // explicit chain across replans
}

interface FindingBullet extends Bullet {
  references?: Reference[];
}

interface DiscussOutput {
  summary: string;
  featureIntent: string;
  successCriteria: Bullet[];
  constraints: Bullet[];
  risks: Bullet[];
  externalIntegrations: Bullet[];
  antiGoals: Bullet[];
  openQuestions: Bullet[];
}

interface ResearchOutput {
  summary: string;
  essentialFiles: FindingBullet[];
  patternsToReuse: FindingBullet[];
  riskyBoundaries: FindingBullet[];
  proofFirst: FindingBullet[];
  verificationSurfaces: FindingBullet[];
  planningNotes: Bullet[];
}

interface Task {
  // ...
  references?: Reference[];   // replaces string[]
}
```

Validation: TypeBox (already the repo pattern via `@sinclair/typebox` and `pi-agent-core` `AgentTool<TParameters extends TSchema>`). `submitDiscuss` / `submitResearch` schemas encode the envelope directly, giving agents a structured tool-input contract and runtime-validated parse-back on read.

Bullet id stamping is host-owned (`src/agents/tools/feature-phase-host.ts`): agents submit bare bullets, host assigns stable `b-<n>` ids during submit. Keeps agents out of the id-generation business.

## Why It Matters (When Upgrading Pays Off)

Raw markdown loses three capabilities that become load-bearing once consumers exist:

- **Stable cross-reference ids.** `Reference.kind='decision' | 'finding'` lets a task point at a specific decision/finding by id. With markdown the best a task can do is quote-embed or line-anchor, both of which drift when the source text is rewritten.
- **Programmatic filtering.** TUI panels like "features with unresolved open questions", "outstanding risks across milestone", or "planning notes blocking execute" need section-level queries. Structured fields make this one SQL/JSON path lookup; markdown needs regex over free text, which is fragile.
- **Explicit supersedes chain on replan.** Replanning can restamp bullets and record `supersedes` links, preserving audit of which decision replaced which. With markdown, replan either overwrites (loses history) or append-patches (noisy diff). The events log partly covers this but is append-only and not indexable by decision identity.

## How It Would Be Implemented

1. Replace `discuss_output` / `research_output` column contents (still `TEXT`) from raw markdown to `JSON.stringify(DiscussOutput)` / `JSON.stringify(ResearchOutput)`. Schema change is payload-shape only, no SQL DDL if v0.0.0 — with pre-existing databases, this needs a migration.
2. Introduce `src/core/types/bullets.ts` (or similar) with `Bullet`, `FindingBullet`, `BulletId`, `Reference`, `DiscussOutput`, `ResearchOutput`.
3. Rewrite `src/agents/tools/schemas.ts` `discussSubmitSchema` / `researchSubmitSchema` to TypeBox envelope shapes. Add `referenceSchema` discriminated union via `Type.Union([Type.Object({kind: Type.Literal(...), ...}), ...])`.
4. `src/agents/tools/feature-phase-host.ts` `submitDiscuss` / `submitResearch` stamp `bulletId`s walking each `Bullet[]` section before storing.
5. Optional: call `Value.Check` from `@sinclair/typebox/value` inside the submit methods and in `codecs.ts` read-back to catch drift loudly rather than silently mis-typing.
6. Rewrite the discuss/research prompt bodies (`src/agents/prompts/discuss.ts`, `research.ts`) so the agent emits envelope-shaped output instead of markdown. Document that `id` and `supersedes` are tool-assigned.
7. Add markdown renderer for envelopes in prompt context assembly (`src/agents/context/index.ts` + prompt builders) so downstream phases see the same markdown block they see today. This preserves prompt behavior while internal representation stays structured.
8. `Task.references` upgrade from `string[]` to `Reference[]` touches four surfaces: proposal ops (`src/core/proposals/index.ts`), graph task mutations (`src/core/graph/creation.ts`, `task-mutations.ts`), runtime task payload builder (`src/runtime/context/index.ts`), and worker system prompt (`src/runtime/worker/system-prompt.ts`). Plus matching TypeBox schemas in `src/agents/tools/schemas.ts`.
9. Test updates: `test/unit/persistence/codecs.test.ts`, `test/unit/persistence/feature-graph.test.ts`, `test/unit/agents/context.test.ts`, `test/unit/agents/tools/proposal-host.test.ts`, `test/unit/core/graph.test.ts`, `test/unit/runtime/context.test.ts`, `test/unit/runtime/worker-system-prompt.test.ts`, `test/unit/agents/prompts/prompt-library.test.ts`.
10. Docs: `docs/architecture/data-model.md` (envelope types), `docs/architecture/persistence.md` (column comment clarification), `docs/agent-prompts/discuss-feature.md` + `research-feature.md` (envelope vocabulary).

## Why Deferred

No consumer today reads the structured shape. The baseline pipes markdown blobs straight from submit → persisted row → downstream prompt context, and downstream prompts render with `renderLabeledBlock(getString(input, 'decisions'))` — a single string, not section-aware. Adding envelopes now buys a richer internal representation that nothing queries, plus:

- A discriminator schema (`Reference` union) adds prompt complexity — agents must pick the right `kind` and supply correct fields. Raw string references fail open; typed references fail closed on kind mismatch.
- Host-side id stamping adds coordination surface between tool runtime and downstream consumers. Until something reads a bullet by id, the id is ceremony.
- Task.references cascade ( ~4 additional src files + 3 additional tests ) doubles the diff. With no dependent reader, deleting string refs just to retype them without gaining behavior is motion without progress.

## When to Upgrade

Promote from candidate to baseline when any of these concrete consumers arrives:

- TUI panel that filters feature rows by section (open questions, unresolved risks, pending proofs).
- Planner/replanner tool that must cite a specific decision id when generating task `references`, and that citation gets used downstream (e.g. verify phase validates "task T cites decision D3; D3 still holds").
- Replan audit UI showing supersedes chain across revisions.
- Cross-feature query like "which features share risky-boundary finding F7".

Any one of these justifies the migration cost. Until then, raw markdown plus the events log provides equivalent user-facing information at zero structural cost.

## Notes Carried Forward From Design Discussion

- Zod was considered and rejected: pi-sdk `AgentTool<TParameters extends TSchema>` is already built on TypeBox, zod would require `zod-to-json-schema` conversion and parallel schemas in `src/`.
- Adhoc hand-validators rejected: triplicates TS interface + hand validator + hand-written JSON Schema for LLM tool-use, with linear drift risk.
- Considered middle-ground `{ markdown: string; openQuestions?: string[] }` carving out only the fields with non-display use. Kept as a possibility if exactly one section becomes query-critical before the full upgrade is worthwhile.
- `Reference.location` as a magic-string dual key (`"<featureId>#<bulletId>"`) rejected in favor of structured `{featureId, bulletId}` fields so it indexes cleanly and does not typecheck invalid combinations.
