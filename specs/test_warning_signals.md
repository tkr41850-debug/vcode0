# test_warning_signals

## Goal

Capture the baseline warning system behavior for verification timing, feature churn, and long blocking.

## Scenarios

### Slow verification emits a non-failing warning
- Given a verification check exceeds its configured warning threshold
- When the orchestrator records the completed check
- Then it emits a warning event
- And the task or feature is not failed solely because of the warning

### Feature churn accumulates repeated recovery-loop signals
- Given the same feature repeatedly fails pre-queue verification (`ci_check` or `verifying`) or merge-train verification
- When replan cycles and queue ejections accumulate
- Then the orchestrator increments feature churn counters
- And may emit a churn warning after the configured threshold is crossed

### Long cross-feature blocking emits a warning
- Given a secondary feature remains blocked behind a primary feature for more than 8 hours
- When the block duration crosses the warning threshold
- Then the orchestrator emits a warning event for long blocking

### Warning history supports later trend analysis
- Given multiple verification and churn warnings have already been emitted over time
- When the warning system enters its later trend-detection stage
- Then the persisted history is sufficient to derive trend-based warnings
- And the earlier threshold-based warnings remain valid on their own
