# Docs Cleanup — 2026-04-29

Record of a one-pass cleanup of `docs/`. Use this as the playbook if a similar pass is repeated.

## Findings (pre-cleanup)

The audit ran via an `Explore` subagent + a Python broken-link checker.

1. **Broken relative links (6):** several pages in subfolders linked to root files (`ARCHITECTURE.md`, `specs/`) using one `..` instead of two — left over from before the docs were split into `architecture/`, `operations/`, etc.
2. **Filename collision:** `docs/optimization-candidates/verification-and-recovery.md` (a future optimization) shared a filename with `docs/operations/verification-and-recovery.md` (current behavior). Confusing in cross-doc refs.
3. **Convention drift:** `docs/compare/README.md` documents an `## Adoption status` section convention. Only 1 of 17 content files (`prompt-techniques-research.md`) followed it.
4. **Oversized flat folders:** `docs/feature-candidates/` had 29 flat files; `docs/compare/` had 17 flat files. Both READMEs already grouped them implicitly — the structure just wasn't promoted to the filesystem.

## Steps

### Step 1 — Fix broken relative links

Mechanical. Six `Edit` calls across two files:

- `docs/operations/testing.md:3,60` — `../ARCHITECTURE.md` → `../../ARCHITECTURE.md`; `../specs/` → `../../specs/`.
- `docs/architecture/worker-model.md:3,342,358` — `../ARCHITECTURE.md` → `../../ARCHITECTURE.md`; `./operations/...` → `../operations/...`; `./optimization-candidates/...` → `../optimization-candidates/...`.

Verification: a Python script walks every `*.md` under `docs/` plus `ARCHITECTURE.md`, regex-matches `[…](rel.md)` links, and resolves each path. Run it after every change. Zero broken links is the bar.

### Step 2 — Rename the colliding optimization-candidate

- `git mv docs/optimization-candidates/verification-and-recovery.md docs/optimization-candidates/verification-reuse.md`
- Updated 2 inbound refs:
  - `docs/optimization-candidates/README.md`
  - `docs/concerns/verification-and-repair-churn.md`

### Step 3 — Backfill `## Adoption status` per `docs/compare/` topic group

The compare README defines the adoption-status convention with a strict table format (`Rec | Status | Commit | Notes`) and a fixed status vocabulary (`done | partial | open | deferred | rejected`). Only `prompt-techniques-research.md` followed it. Backfill needed real evidence (git log, codebase greps, cross-doc lookups) per recommendation, so it was farmed out.

**Subagent role:** one backgrounded Sonnet `general-purpose` subagent per topic group (7 total, in parallel). Each agent received a self-contained brief listing only its in-scope files plus a pointer to `prompt-techniques-research.md` as the reference template. Each was told to:

- Read every file in scope, enumerate actionable recommendations.
- For each rec, search `git log --all --grep` and the source tree for adoption evidence.
- Search `docs/feature-candidates/`, `docs/concerns/`, `docs/optimization-candidates/` for matching deferred items (those become `deferred` with a Notes link).
- Insert one `## Adoption status` section per file at the conventional position (after `## Key external sources` if present).

Why per-group instead of per-file or one big agent: per-file fragments context (each agent re-reads the convention); one-big-agent serializes 17 files of read+edit work and produces a context blowup. Per-group is the natural granularity — files within a group share concepts (e.g., the three token-economics docs all hit the same prompt-cache code paths), so an agent reading them benefits from the cross-file context.

**Outcomes:**

- `landscape/` (2 files): 17 recs total — 1 done, 1 partial, 15 open.
- `research/` (5 files): 22 recs — 8 done, 2 partial, 7 deferred, 5 open.
- `token-economics/` (3 files backfilled, 1 already done): 36 recs — 0 done, 2 partial, 1 rejected, 33 open.
- `lineage/` (1 file): 15 recs — 11 done, 2 partial, 1 rejected, 1 open.
- `competitors/` (2 files): 11 recs — 1 deferred, 10 open.
- `critical-lenses → competitors/` (1 file): 6 recs — 1 deferred, 5 open.
- `alternatives/` (2 files): 11 recs — 2 deferred, 1 rejected, 8 open.

### Step 4 — Subgroup `docs/feature-candidates/` and `docs/compare/`

Both folders had grouping in their READMEs but not on disk. Promoting the grouping reduces cognitive load and matches the convention used elsewhere in `docs/`.

**Taxonomy:**

- `feature-candidates/coordination/` (7) — merge train, suspension, replan, integration cancel.
- `feature-candidates/lifecycle/` (4) — cancel, kill, timeouts.
- `feature-candidates/runtime/` (8) — IPC, harness, scheduling, persistence, repair, budget.
- `feature-candidates/data-model/` (5) — typing, validation, structured outputs, proposal state.
- `feature-candidates/interop/` (5) — `absurd`, AGENTS.md, SARIF, git-tracked exports.
- `compare/landscape/` (2), `compare/research/` (5), `compare/token-economics/` (4), `compare/lineage/` (1), `compare/competitors/` (3), `compare/alternatives/` (2).

**Script role:** `/tmp/regroup_feature_candidates.py` and `/tmp/regroup_compare.py`. Each script:

1. Defines the file→group mapping as a dict and asserts it covers exactly the existing files (no drift between intent and disk).
2. Rewrites outbound links from every file *outside* the target folder: `<folder>/<file>.md` → `<folder>/<group>/<file>.md`.
3. Rewrites intra-folder links: same-group `./<file>.md` stays put; cross-group becomes `../<group>/<file>.md`. Existing `../<docs-sibling>/...` refs gain one extra `../` (the file is now one level deeper).
4. `git mv`s each file into its group subfolder.

The intra-folder rewrite step is the brittle one. The first pass had two bugs that the post-move broken-link sweep caught:

- The cross-group rewrite captured the closing `]` from the markdown title, producing `]](` instead of `](`. Fixed by a follow-up `replace(']](', '](')` over the affected files.
- The `../<dir>/...` → `../../<dir>/...` rule applied to *every* directory name, including the new sibling group folders. Result: cross-group refs ended up two levels deep instead of one. Fixed by a follow-up that explicitly rewrites `../../<group>/` → `../<group>/` for each known group name.

Lessons for the next pass: build the regex around an explicit list of *outside-the-folder* siblings (architecture, operations, etc.) rather than a generic `[a-z]+` directory match, and have the title regex capture exclude the closing bracket.

### Step 5 — Rewrite both folder READMEs

The READMEs were rewritten to reflect the on-disk grouping (each group becomes an H2 with a one-line description and the file list). The compare README also got its `landscape/2026-04-29-deep-dive-synthesis.md` cross-ref updated for the new path.

## Verification gate

After every step, the Python broken-link script runs over the entire docs tree:

```python
import re
from pathlib import Path
for md in list(Path('docs').rglob('*.md')) + [Path('ARCHITECTURE.md')]:
    text = md.read_text()
    for m in re.finditer(r'\[([^\]]+)\]\(([^)#\s]+\.md)(#[^)]*)?\)', text):
        target = m.group(2)
        if target.startswith('http'): continue
        if not (md.parent / target).resolve().exists():
            print(f'{md}:{text[:m.start()].count(chr(10))+1}: {target}')
```

Final state: zero broken relative `.md` links.

## What was deliberately not done

- **Splitting `docs/architecture/worker-model.md` (615 lines).** Identified as a candidate but deferred — the cost/benefit is moderate and the file is topically coherent. Worth doing only when next editing it substantively.
- **Splitting the 500–600-line compare/token-economics docs.** Same reasoning. Each is a single research thread; arbitrary mid-doc splits would harm readability.
- **Cross-linking from `docs/operations/*.md` into specific `specs/test_*.md` files.** Nice-to-have, not a fix.
