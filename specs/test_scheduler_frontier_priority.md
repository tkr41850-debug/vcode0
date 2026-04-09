# test_scheduler_frontier_priority

## Goal

Capture ready-frontier recomputation and scheduler ordering across milestone steering, critical path, and reservation-overlap penalties.

## Scenarios

### Ready frontier updates after dependency completion
- Given a task depends on another task in the same feature
- When the dependency task completes successfully
- Then the dependent task enters the ready frontier
- And the scheduler may dispatch it on the next scheduling pass

### Independent ready tasks dispatch in parallel
- Given multiple tasks in the same feature have all dependencies satisfied
- When worker capacity is available
- Then the scheduler may dispatch them in parallel
- And no artificial serialization is introduced within that ready frontier

### Milestone steering sorts before critical-path weight
- Given ready tasks exist in multiple queued milestones
- When the scheduler prioritizes runnable work
- Then earlier queued milestone positions sort ahead of later queued milestones
- And critical-path weight only breaks ties within the same milestone queue bucket

### Critical-path weight wins within the same queue bucket
- Given two ready tasks are in the same effective milestone bucket
- And one sits on the longer weighted downstream path
- When the scheduler chooses which task to dispatch first
- Then the higher critical-path-weight task sorts first

### Unqueued work backfills idle workers
- Given queued milestone buckets do not supply enough runnable work to fill all idle workers
- When other ready tasks exist outside the queued milestones
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
- And critical-path weight becomes the primary ordering signal again
