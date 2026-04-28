# test_cross_feature_overlap_runtime

## Goal

Capture the runtime coordination protocol for cross-feature overlap before final integration.

## Scenarios

### Primary and secondary are chosen once per feature pair
- Given two active features overlap on normalized project-root-relative paths
- When runtime coordination begins
- Then the orchestrator chooses one primary and one secondary for that feature pair
- And it does not split ownership per file within the same incident

### Primary and secondary selection follows the documented ranking order
- Given two active features overlap and neither has already been assigned pair ownership
- When the orchestrator ranks them for runtime coordination
- Then it compares explicit dependency predecessor first
- And then nearer-to-merge state, stable request-order proxy, downstream blocking count, and finally lexical feature id

### Whole secondary feature is paused
- Given a primary and secondary feature have been selected
- When the orchestrator pauses work for runtime overlap
- Then all running tasks in the secondary feature are paused
- And the secondary feature remains blocked behind the primary until rebase or replanning outcome resolves the overlap

### Long secondary blocking emits a warning
- Given a secondary feature remains blocked behind a primary feature for more than 8 hours
- When the orchestrator evaluates blocked-feature warnings
- Then the orchestrator emits a long-block warning
- And the secondary feature remains paused until the primary path is resolved

### Secondary feature rebases after primary lands
- Given the primary feature has merged into `main`
- When the orchestrator resumes the blocked secondary side
- Then it rebases the secondary feature branch onto the updated `main`
- And only then considers resuming suspended secondary tasks

### Successful feature-branch rebase resumes suspended tasks
- Given the secondary feature branch rebases cleanly after the primary lands
- When the orchestrator resumes the secondary feature
- Then suspended secondary tasks rebase their task worktrees onto the updated secondary feature branch
- And future active path locks are reacquired lazily on later writes

### Failed feature-branch rebase reroutes to replanning and keeps secondary paused
- Given the secondary feature branch cannot be rebased cleanly after the primary lands
- When the orchestrator processes that failure
- Then it persists `source: 'rebase'` `VerifyIssue[]` on the secondary feature
- And it routes the secondary feature to `replanning`
- And secondary feature tasks remain paused until approved replan work lands
