# test_scheduler_frontier_priority

## Goal

Capture ready-frontier recomputation and scheduler ordering across milestone steering, work-type tiers, critical path (combined graph), and reservation-overlap penalties. The scheduler operates on `SchedulableUnit` values covering both task execution and feature-phase agent work.

## Scenarios

### Ready frontier updates after dependency completion
- Given a task depends on another task in the same feature
- When the dependency task completes successfully
- Then the dependent task enters the ready frontier
- And the scheduler may dispatch it on the next tick

### Independent ready tasks dispatch in parallel
- Given multiple tasks in the same feature have all dependencies satisfied
- When worker capacity is available
- Then the scheduler may dispatch them in parallel
- And no artificial serialization is introduced within that ready frontier

### Milestone steering sorts before work-type tier and critical-path weight
- Given ready work exists in multiple queued milestones
- When the scheduler prioritizes runnable work
- Then earlier queued milestone positions sort ahead of later queued milestones
- And work-type tier and critical-path weight only break ties within the same milestone queue bucket

### Work-type tier sorts before critical-path weight within a milestone bucket
- Given ready work of different types exists in the same milestone bucket
- When the scheduler prioritizes runnable work
- Then verification/ci_check work sorts ahead of task execution
- And task execution sorts ahead of planning/discuss/research/replan work
- And planning work sorts ahead of summarization work

### Critical-path weight wins within the same work-type tier
- Given two ready tasks of the same work type are in the same effective milestone bucket
- And one sits on the longer weighted downstream path in the combined graph
- When the scheduler chooses which to dispatch first
- Then the higher critical-path-weight unit sorts first

### Combined graph spans feature boundaries for critical path
- Given a task in feature A has high critical-path weight because feature B depends on feature A
- And a task in feature C has low critical-path weight because nothing depends on feature C
- When both are in the same milestone and work-type tier
- Then the task in feature A sorts first because the combined graph includes cross-feature downstream weight

### Feature-phase work competes with task execution
- Given a feature needs verification and another feature has ready tasks
- When both are in the same milestone bucket
- Then verification sorts ahead of task execution because verify tier > execute tier

### Unqueued work backfills idle workers
- Given queued milestone buckets do not supply enough runnable work to fill all idle workers
- When other ready work exists outside the queued milestones
- Then the scheduler may dispatch that unqueued work
- And milestone steering does not leave workers idle unnecessarily

### Reservation-only overlap applies penalty instead of hard block
- Given a ready task has only reservation-level cross-feature overlap with active work
- When higher-priority non-overlapping ready work still exists
- Then the overlapping task sorts later
- But it remains runnable once better non-overlapping work is exhausted

### Clearing queued milestones returns to autonomous critical-path scheduling
- Given the user previously queued milestones as a steering override
- When the queued milestone list is cleared
- Then scheduler ordering returns to the normal autonomous ready-frontier policy
- And work-type tier then critical-path weight become the primary ordering signals

### Cross-milestone dependency pulls work forward with warning
- Given a feature in milestone 1 (higher priority) depends on an incomplete feature in milestone 2 (lower priority)
- When the scheduler computes the ready frontier
- Then the blocking feature's work in milestone 2 is pulled forward past its natural milestone ordering
- And a scheduling priority warning is emitted because milestone priority inversion suggests decomposition may need revision
