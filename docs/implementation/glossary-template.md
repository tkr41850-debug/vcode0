# <track-name> — Glossary

Track-specific jargon used across phases in `docs/implementation/<track>/`. Add a term once it recurs across **3+ phases**; one-off terms are glossed inline at first use in the phase doc itself.

- **Scope**: terms that are specific to this track. Cross-track concepts (`worktree`, `merge train`, `feature branch`) live in `docs/architecture/` — link there, don't redefine.
- **First-use linking**: phase docs link the glossed term on first occurrence per phase: `[submit invariants](../glossary.md#submit-invariants)`.
- **Format**: alphabetical. One short paragraph per entry, ≤3 sentences. Cite the live source path or architecture doc that owns the concept.
- **Lifecycle**: when a term stops appearing in active phase docs (e.g., the concept it names was retired), strike-through the entry rather than delete, so old phase-doc links don't 404. Remove on the next archival pass.

---

## Example entry shape

### submit invariants

The set of preconditions a planner submit must satisfy before the orchestrator accepts it: non-empty feature graph, valid root id, no orphan tasks. Defined in `src/agents/planner/submit-validator.ts`. See [docs/architecture/planner.md](../../architecture/planner.md) for the full rule list.

### request_help frame

IPC frame variant carrying `{question, context_ref, urgency}` from a planner agent to its host. Replaces the legacy `console.error("HELP:")` prefix path. Frame schema lives in `src/runtime/ipc/frames.ts`; persistence row in `agent_events` (kind `help_request`).

---

(Delete this template's example entries when bootstrapping a real glossary; they exist only to show the canonical shape.)
