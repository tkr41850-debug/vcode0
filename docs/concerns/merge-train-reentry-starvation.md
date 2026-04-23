# Concern: Merge-Train Re-entry Starvation

## Concern

The merge-train queue sorts by `mergeTrainReentryCount` descending as a secondary key (after manual position). A feature that has been ejected and re-entered multiple times gets priority over first-time queue entrants. Combined with an uncapped re-entry count, a repeatedly-failing feature can block newer healthy features from integrating.

## Why to Watch

The re-entry-descending sort was chosen to prioritize repair work on features that have already invested effort in the queue. This is usually the right call — a feature that almost merged deserves another chance promptly. It becomes pathological when the re-entry cause is structural and the feature never stabilizes.

## What to Observe

- Healthy features waiting behind repeatedly-failing features
- Median time-to-merge skewed by a few high-re-entry features
- Operator reports of a healthy feature stuck behind a broken one

## Current Position

Keep the re-entry-descending sort. Rely on replan-loop counters to catch broken features before starvation sets in. Revisit if observation shows meaningful starvation of healthy features.

## Related

- [Feature Candidate: Fine-Grained Merge-Train Priority](../feature-candidates/merge-train-niceness.md)
- [Concern: Merge-Train Re-entry Cap](./merge-train-reentry-cap.md)
