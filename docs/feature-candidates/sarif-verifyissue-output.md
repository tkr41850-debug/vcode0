# Feature Candidate: SARIF Output for VerifyIssue

## Status

Future feature candidate. Surfaced from the [2026-04-29 deep-dive synthesis](../compare/2026-04-29-deep-dive-synthesis.md).

## Baseline

`VerifyIssue` is a typed discriminated union with sources `verify | ci_check | rebase`, persisted as JSON in the events table and consumed internally by the replanner. There is no external serialization format — `VerifyIssue` payloads are gvc0-internal only.

## Candidate

Add an optional SARIF output mode that emits each `VerifyIssue` payload as a SARIF 2.1.0 result. The internal typed payload remains the first-class representation; SARIF is a serialization for downstream interop.

```ts
// Conceptual mapping (actual code lives in src/orchestrator/verify/sarif-emitter.ts).
function toSarifResult(issue: VerifyIssue): SarifResult {
  return {
    ruleId: `gvc0/${issue.source}`,
    level: severityToSarifLevel(issue.severity),
    message: { text: issue.message },
    locations: issue.location ? [toSarifLocation(issue.location)] : [],
    properties: {
      gvc0Source: issue.source,           // 'verify' | 'ci_check' | 'rebase'
      gvc0AgentRunId: issue.agentRunId,
      gvc0FeatureId: issue.featureId,
    },
  };
}
```

Output channels:

- File: `<worktree>/.gvc0/verify-issues.sarif` (per-feature, atomic write).
- Optional CLI flag: `gvc0 verify --sarif=<path>` for ad-hoc export.
- Optional GitHub Code Scanning upload: emit + push via `actions/github-script` when running in CI.

## Why It Matters

SARIF (Static Analysis Results Interchange Format) is OASIS-standard JSON for issue payloads. By 2026-04 it's the de facto interchange format for "list of issues with locations and severity," consumed by:

- **GitHub Code Scanning** — verify failures appear as PR annotations.
- **VS Code Problems panel** — developers see them locally without extra tooling.
- **Most static-analysis tool ecosystems** — lint, security scan, typecheck.

`VerifyIssue` already has the shape of a SARIF result (source, severity, location, message). Emitting an optional SARIF stream alongside the typed internal payload is internal-shape preserving: `VerifyIssue` stays first-class; SARIF is the serialization.

The interop wins are concrete:

- A user running `gvc0` on a GitHub-hosted repo gets verify failures as PR annotations for free.
- A developer running gvc0 locally sees verify issues in their VS Code Problems panel without a custom extension.
- Downstream tools (security scanners, custom CI) can ingest gvc0 output via the same path they already use for other static analyzers.

## How It Would Be Implemented

1. Add `src/orchestrator/verify/sarif-emitter.ts` with the typed mapping `VerifyIssue → SarifResult`.
2. Hook the emitter into the verify-failure path: when verify produces a non-empty `VerifyIssue[]`, write the SARIF file alongside the existing event-log entry. Both writes are best-effort (SARIF write failure does not block the replanner).
3. CLI surface: `gvc0 verify --sarif=<path>` for ad-hoc export of the latest verify run on the active feature.
4. Optional GitHub Action: a `gvc0-sarif-upload` action that finds the latest SARIF file and uploads via `github/codeql-action/upload-sarif@v3`. Lives in `examples/` rather than core.
5. Schema validation: a unit test runs the SARIF JSON through the published 2.1.0 JSON Schema to catch drift if the SARIF spec evolves.
6. Severity mapping: `VerifyIssue` severity maps to SARIF `level` (`error | warning | note | none`). Document the mapping table.
7. Location mapping: `VerifyIssue` location (if present) maps to SARIF `physicalLocation` with `artifactLocation` + `region`. Absent locations produce a result without a `locations` array (valid SARIF).
8. Documentation: a topic page in `docs/operations/` describing the SARIF output and downstream integrations.

## Why Deferred

- No external consumer is asking for SARIF today. The interop wins are real but speculative-until-someone-uses-them.
- The SARIF mapping is the kind of detail that should be validated against a real consumer (GitHub Code Scanning ingestion) before locking in. Premature commitment to a mapping risks needing a v2 mapping later.
- Severity semantics in `VerifyIssue` are gvc0-specific; mapping them onto SARIF's coarser severity model loses information. Worth thinking about whether to expose the original severity in `properties` (yes) and how to document the lossy mapping.

## When to Promote

Promote from candidate to baseline when:

- A user requests a downstream integration that SARIF would unblock (GitHub Code Scanning is the most likely first ask).
- gvc0 ships any kind of CI integration (the existing CI is for gvc0's own repo, not for gvc0-orchestrated repos).
- An internal use case emerges for cross-feature issue aggregation; SARIF is a reasonable canonical format to aggregate into.

## Public references

- SARIF 2.1.0 spec: <https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html>
- GitHub Code Scanning consumption: <https://docs.github.com/en/code-security/code-scanning>
- Topic page: [verification-architectures.md](../compare/verification-architectures.md).

## Notes Carried Forward From Design Discussion

- Considered making SARIF the primary internal payload format; rejected. SARIF is verbose, not strongly-typed in the gvc0 sense, and would force every consumer to deserialize. Internal `VerifyIssue` stays typed; SARIF is the export format.
- Considered emitting SARIF for every verify run including success cases; rejected. SARIF is for issues; a clean run produces an empty results array, which is correct but generates artifact churn. Default to writing only on non-empty results.
- Considered uploading to GitHub Code Scanning automatically; rejected for baseline. Auto-upload couples gvc0 to a specific CI provider. Ship as an example, not as core.
