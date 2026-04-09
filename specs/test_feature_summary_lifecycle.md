# test_feature_summary_lifecycle

## Goal

Capture normal and budget-mode post-merge summarization, including derived summary availability.

## Scenarios

### Normal merge writes summary before work complete
- Given a feature has already integrated successfully
- And feature collaboration control is `merged`
- When the normal post-merge summary path runs
- Then feature work control enters `summarizing`
- And summary text is written before the feature reaches `work_complete`

### Budget profile skips summarizing and leaves summary empty
- Given a feature has already integrated successfully
- And the project is using the `budget` token profile
- When post-merge completion continues
- Then the feature may move directly to `work_complete`
- And no summary text is written

### Derived summary availability waits during summarizing
- Given a feature is in `summarizing`
- And it has no summary text yet
- When the UI or downstream logic derives summary availability
- Then summary availability is treated as waiting

### Derived summary availability is skipped after work complete without summary text
- Given a feature is in `work_complete`
- And it has no summary text
- When the UI or downstream logic derives summary availability
- Then summary availability is treated as skipped

### Summary text means summary is available
- Given a feature has summary text
- When the UI or downstream logic derives summary availability
- Then summary availability is treated as available
- And downstream context assembly may include that summary
