# Phase 2 — Merge-train race safety

## Goal

Close the TOCTOU window between the main-SHA re-check and the `git merge --no-ff` call inside `IntegrationCoordinator`. Atomic at the git ref-update layer instead of relying on a check-then-act pattern. Do this without mutating any working tree, since the integration coordinator runs in the orchestrator's CWD (`process.cwd()`, see `src/orchestrator/integration/index.ts:48`) — not a dedicated integration worktree as the original plan assumed.

## Background

`src/orchestrator/integration/index.ts:137-156` reads `main` SHA via `revparse` and compares it to `expectedParentSha`. Lines `:158-159` then run `mainGit.checkout(this.mainBranch)` and `mainGit.merge(['--no-ff', feature.featureBranch])` — without any concurrency guard. Between line 137 and line 159 main may advance (concurrent push, second orchestrator instance), and the merge proceeds onto the new tip. The reconciler then sees `parents[0] !== expectedParentSha` and stalls the feature in `halted`.

Two facts shape the design:

1. **`git merge` does not accept `--force-with-lease`.** Empirically: git 2.52.0 returns `unknown option`. The flag exists on `git push` and `git fetch` only. So "add `--force-with-lease` to the merge invocation" is not viable.
2. **The integration coordinator runs in the orchestrator's CWD.** `IntegrationCoordinator.cwd = deps.cwd ?? process.cwd()` (`:48`), and `mainGit = simpleGit(this.cwd)` (`:51`). There is no dedicated integration worktree. Detaching HEAD or running `git merge` here mutates the orchestrator's actual working tree files. Today's `:158-159` already does this; the redesign should avoid making it worse.

The fix uses git plumbing (`merge-tree` + `commit-tree` + `update-ref`) to build the merge commit *without ever touching the working tree*, then atomically swing `refs/heads/main` via `update-ref <ref> <new> <old>` (canonical compare-and-swap).

Single-orchestrator deployments rarely hit the TOCTOU race. Multi-orchestrator deployments (or any environment where humans can push to main) make it real.

## Steps

The phase ships as **1 commit**.

---

### Step 2.1 — Plumbing merge + atomic CAS swing of `refs/heads/main`

**What:** stop running `git merge` on the working tree. Instead:

1. Compute merge base: `git merge-base <expectedParentSha> <featureBranch>` — output is the merge-base SHA.
2. Build merge tree without touching the working tree: `git merge-tree --write-tree --merge-base=<base> <expectedParentSha> <featureBranch>` — outputs the resulting tree SHA on stdout (modern git ≥ 2.38; verified available on 2.52.0). On conflict, git exits non-zero with conflict info on stderr/stdout.
3. Build merge commit: `git commit-tree <tree> -p <expectedParentSha> -p <featureSha> -m <mergeMessage>` — outputs the merge commit SHA. Equivalent to a `--no-ff` merge, but produced as a pure plumbing operation without any working-tree mutation. **`featureSha` provenance**: use the `postRebaseSha` value the coordinator already records at `src/orchestrator/integration/index.ts:115-117` (post-rebase feature tip). Do not re-resolve `featureBranch` at commit-tree time — a concurrent push to the feature branch between rebase completion and commit-tree would produce a parent shape the reconciler does not recognize. The reconciler at `src/orchestrator/integration/reconciler.ts:87-90` checks `parents[1] === featureBranchPostRebaseSha`; pinning `featureSha = postRebaseSha` is the only way to satisfy that invariant.
4. Atomic CAS: `git update-ref refs/heads/main <mergeSha> <expectedParentSha>`. Succeeds iff main still points at `expectedParentSha`; otherwise git errors with `cannot lock ref 'refs/heads/main': is at <new>... but expected <old>` and exits non-zero.
5. On `update-ref` failure: no working-tree mutation occurred, no ref was updated, the new merge commit (`<mergeSha>`) is dangling and will be garbage-collected eventually. Call `rerouteToReplan(featureId, [issue])` (`src/orchestrator/features/index.ts:51`) with a `RebaseVerifyIssue` whose `source: 'rebase'` (NOT `'squash'` — that is reserved for Phase 5's squash exhaustion to disambiguate concurrency loss from inherent conflict), `description` mentions "main moved during integration", and `conflictedFiles: []` (no files conflicted — main simply advanced; mirror the existing reroute shape at `src/orchestrator/integration/index.ts:142-150`). Note: `main_moved` is an `IntegrationOutcome.kind`, not a `VerifyIssue` discriminator — do not invent a new issue source/code.
6. On conflict during step 2's merge-tree: identical to today's rebase conflict — return `kind: 'conflict'` (or the equivalent existing path; the integration coordinator already handles rebase conflicts via `runRebase` at `:178-194`, but the post-merge-tree conflict is a distinct case because a clean rebase succeeded and then merge-tree disagrees — this should not happen in practice, but log it loudly if it does).

**Important advantage**: this design removes the existing `mainGit.checkout(this.mainBranch)` + `mainGit.merge(...)` pair entirely. The orchestrator's working tree is no longer mutated by the integration step. Subsequent `mainGit.revparse(['main'])` calls return the new merge SHA because the *ref* moved, regardless of working-tree state. If the orchestrator's working tree appears stale, that is acceptable — the orchestrator does not read its own working tree files; it only reads refs and worktrees of features.

**Files:**

- `src/orchestrator/integration/index.ts` — replace lines `:158-159` (the `checkout` + `merge` pair) with the four-step plumbing sequence above. Use `mainGit.raw(['merge-base', expectedParentSha, feature.featureBranch])`, `mainGit.raw(['merge-tree', '--write-tree', `--merge-base=${base}`, expectedParentSha, feature.featureBranch])`, `mainGit.raw(['commit-tree', tree, '-p', expectedParentSha, '-p', featureSha, '-m', mergeMessage])`, `mainGit.raw(['update-ref', 'refs/heads/main', mergeSha, expectedParentSha])`. Each `raw` returns trimmed stdout on success and throws on non-zero exit.
- The TOCTOU pre-check at `:137-156` (compare `currentMainSha !== expectedParentSha`) becomes redundant once `update-ref` is atomic, but keep it for fast-fail semantics — the cheap check skips building a doomed merge commit when main has already moved before we even start. The CAS at step 4 is the actual safety guarantee, not the pre-check.
- Detect `update-ref` lease failure by inspecting the `raw` rejection's stderr for the substring `cannot lock ref` (git's exact phrasing; matches across recent git versions). Also handle non-zero exit code as the primary signal — the substring match is a backstop in case future versions tweak phrasing.
- (No git-wrapper file to touch — `src/runtime/worker/git/index.ts` does not exist; `simple-git` exposes the plumbing commands via `raw`. A repo-local git helper exists at `src/orchestrator/conflicts/git.ts` for reference, but the integration path uses `simpleGit` directly via the `mainGit` field.)

**Tests:**

- `test/integration/integration-coordinator-cas.test.ts` — drive the coordinator with two scripted git states: (a) main unchanged → `update-ref` succeeds, merge commit becomes new main tip with `parents[0] === expectedParentSha` and `parents[1] === featureSha`; (b) main advanced between `revparse` and `update-ref` (simulate by mutating the test repo with a second commit on main between the pre-check and the CAS) → expect the `update-ref` call to fail, no main mutation, the dangling merge commit exists but `refs/heads/main` is unchanged, and a `rebase`-source `replan_needed` reroute fires via `rerouteToReplan`.
- The existing coordinator tests in `test/unit/orchestrator/integration-coordinator.test.ts` use real git subprocesses; verify they still pass after replacing the `checkout`+`merge` pair with plumbing. The merge commit shape (two-parent, no-ff) is unchanged from the operator's perspective; only the construction path differs.
- Working-tree assertion: after a successful integration, the orchestrator's CWD has not been mutated (no checkout, no merge). Add an assertion if the harness exposes the working-tree state.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the merge-train change: (1) the merge commit is built via `git merge-tree --write-tree` + `git commit-tree`, NOT via `git merge` on the working tree — the entire point of the redesign is to avoid mutating the orchestrator's CWD; (2) `git update-ref refs/heads/main <new> <old>` is the atomic primitive used, NOT `--force-with-lease` on `git merge` (which does not exist as a flag); (3) the `update-ref` failure detection uses both exit code and stderr substring (`cannot lock ref`); (4) on CAS failure the existing `rerouteToReplan` path is invoked with a `VerifyIssue` carrying source `'rebase'` and a clear `main_moved` description; (5) no other call site does an unguarded `git merge` against main; (6) the existing pre-check at `:137-156` is preserved as a fast-fail (or explicitly removed with justification — the CAS is sufficient on its own); (7) the orchestrator's working tree is not checked out or mutated as part of the integration step. Under 400 words.

**Commit:** `fix(integration): plumbing-based atomic CAS on main ref`

---

## Phase exit criteria

- Commit lands on the feature branch.
- `npm run verify` passes.
- Manual smoke test (optional): two-process race in a scratch repo confirms the `update-ref` CAS fires and no working-tree mutation occurs.
- Run a final review subagent against the merged commit to confirm the plumbing-based merge, `update-ref` CAS, lease-fail detection, `main_moved` reroute, and absence of working-tree mutation are wired correctly end-to-end, and that no other unguarded `git merge` against main exists in the codebase. Address findings before declaring the phase complete.

## Notes

- This phase has only one item. Treat it as a self-contained low-risk patch — do not bundle it with Phase 1 commits, since the merge path is touched by no other phase.
- If a multi-orchestrator deployment is explicitly out of scope, this phase can be deferred. Document the deferral in `docs/concerns/` rather than dropping the plan entirely.
- An alternative implementation uses `git push . <mergeSha>:refs/heads/main --force-with-lease=refs/heads/main:<expectedParentSha>` (lease IS valid on push). Prefer `update-ref` for clarity — local push has more moving parts (refspec parsing, reflog entries, hook firing) and the lease-error format differs across git versions.
- The plumbing approach (`merge-tree --write-tree`) requires git ≥ 2.38. Verified on the project's git 2.52.0. If future deployments target older git, `commit-tree` and `update-ref` are universally available; only `merge-tree --write-tree` would need a fallback (e.g. a temporary worktree).
