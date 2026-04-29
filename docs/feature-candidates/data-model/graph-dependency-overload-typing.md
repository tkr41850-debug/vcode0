# Feature Candidate: Graph Dependency Overload Typing

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline uses a discriminated union for `addDependency` and `removeDependency` on `FeatureGraph`:

```ts
type DependencyOptions = FeatureDependencyOptions | TaskDependencyOptions;

addDependency(opts: DependencyOptions): void;
removeDependency(opts: DependencyOptions): void;
```

This validates edge-type correctness at runtime (rejecting `FeatureId -> TaskId` cross-type edges) but does not prevent such misuse at compile time.

## Candidate

TypeScript overloaded signatures would enforce edge-type correctness at the type level:

```ts
addDependency(opts: FeatureDependencyOptions): void;
addDependency(opts: TaskDependencyOptions): void;
```

This would make `addDependency({ from: featureId, to: taskId })` a compile-time error rather than a runtime validation failure.

## Why Deferred

The discriminated union approach is simpler to implement, easier to type-narrow in the implementation, and sufficient for the baseline where runtime validation already rejects invalid edges. Overload typing adds value only when the codebase has enough callers that compile-time prevention materially reduces bug surface.
