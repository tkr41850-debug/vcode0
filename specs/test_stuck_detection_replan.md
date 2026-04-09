# test_stuck_detection_replan

## Goal

Capture work-control stuck detection and replanning behavior.

## Scenarios

### Repeated verification failure marks task stuck
- Given a task repeatedly fails verification
- When `maxConsecutiveFailures` is reached
- Then task work control becomes `stuck`
- And automatic system execution stops for that task

### Manual attach moves stuck work to running manual
- Given a task is `stuck`
- When the user attaches directly to that task run
- Then the run moves to `running`
- And `owner` becomes `manual`

### Unfinished manual exit becomes await-response manual
- Given a user was manually attached to a stuck task run
- And no unanswered `request_help()` payload exists yet
- When the user exits without finishing the work
- Then the run becomes `await_response`
- And `owner` remains `manual`
- And that state is releasable once the user chooses to hand control back

### Request help pauses into await-response manual
- Given a task execution run hits a semantic blocker
- When it calls `request_help(query)`
- Then the run moves to `await_response`
- And `owner` becomes `manual`
- And the help query is stored in `payload_json`

### Release to scheduler returns ready only when no unanswered help remains
- Given a manually owned run was previously waiting for human response
- When the user triggers `release_to_scheduler`
- Then the run returns to `ready` only if no unanswered `request_help()` state remains
- And otherwise it stays `await_response` with manual ownership

### Replanning proposal waits in await-approval
- Given a stuck or conflicted feature triggers replanning
- When the replanner produces a proposal
- Then that proposal is stored in `payload_json`
- And the replanning run enters `await_approval`

### Approval returns original task to ready unless replaced
- Given a replanning proposal in `await_approval`
- When the user approves it
- Then the graph mutation is applied
- And feature work control leaves the waiting-for-approval point and returns to normal schedulable flow
- And the original stuck task returns to `ready` unless the approved proposal replaced or cancelled it

### Replanning mutates the feature graph
- Given a feature entered `replanning`
- When the replanner runs
- Then it may split the feature, edit tasks, or adjust dependencies
- And the scheduler re-evaluates readiness after replanning
