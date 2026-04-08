# test_stuck_detection_replan

## Goal

Capture work-control stuck detection and replanning behavior.

## Scenarios

### Repeated verification failure marks task stuck
- Given a task repeatedly fails verification
- When `maxConsecutiveFailures` is reached
- Then task work control becomes `stuck`
- And feature work control becomes `replanning`

### User can intervene on stuck work
- Given a task is stuck
- When the user steers the worker
- Then the task may resume execution
- Or the user may cancel the task
- Or trigger replanning

### Replanning mutates the feature graph
- Given a feature entered `replanning`
- When the replanner runs
- Then it may split the feature, edit tasks, or adjust dependencies
- And the scheduler re-evaluates readiness after replanning
