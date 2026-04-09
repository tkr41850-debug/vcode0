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
- And then nearer-to-merge state, older branch-open time, downstream blocking count, changed-line count, and finally lexical feature id

### Only secondary tasks on overlapped paths are paused
- Given a primary and secondary feature have been selected
- When the orchestrator pauses work for runtime overlap
- Then only the secondary feature's tasks that touch the overlapped paths are paused
- And unrelated secondary tasks may continue

### Long secondary blocking emits a warning
- Given affected secondary tasks remain blocked behind a primary feature for more than 8 hours
- When the orchestrator evaluates blocked-feature warnings
- Then the orchestrator emits a long-block warning
- And only the affected secondary tasks remain paused until the primary path is resolved

### Secondary feature rebases after primary lands
- Given the primary feature has merged into `main`
- When the orchestrator resumes the blocked secondary side
- Then it rebases the secondary feature branch onto the updated `main`
- And only then considers resuming affected secondary tasks

### Successful feature-branch rebase resumes affected tasks
- Given the secondary feature branch rebases cleanly after the primary lands
- When paused secondary tasks are resumed
- Then they rebase their task worktrees onto the updated secondary feature branch
- And future active path locks are reacquired lazily on later writes

### Failed feature-branch rebase creates repair work and keeps tasks paused
- Given the secondary feature branch cannot be rebased cleanly after the primary lands
- When the orchestrator processes that failure
- Then it creates integration repair work on the secondary feature branch
- And affected secondary tasks remain paused until that repair lands
