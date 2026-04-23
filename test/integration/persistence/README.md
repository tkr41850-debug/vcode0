# Persistence integration tests

Runtime contracts for the SQLite `Store` port that can only be exercised
against a real file-backed database (fsync + WAL behaviour is not
observable on `:memory:` — see RESEARCH.md Pitfall 6).

## Tests

| File                                    | Gate               | Runtime | Phase SC |
| --------------------------------------- | ------------------ | ------- | -------- |
| `rehydration.test.ts`                   | default            | ~1 s    | SC #3    |
| `migration-forward-only.test.ts`        | default            | ~1 s    | —        |
| `store-transaction-rollback.test.ts`    | default            | ~1 s    | —        |
| `load.test.ts`                          | `LOAD_TEST=1`      | ~10 min | SC #2    |

### `rehydration.test.ts`
Asserts `shutdown() → open() → rehydrate()` yields a snapshot deep-equal
to the pre-shutdown snapshot on a real tmpdir file DB. Gates Phase 9
crash recovery (Phase 2 SC #3).

### `load.test.ts` (gated)
Sustained-write load test: 100 events/sec for 10 minutes against a real
file DB. Records P50/P95/P99 write latency via `process.hrtime.bigint()`
and asserts:

- Sample count within 10% of target volume (`>= 90 * 100 * 60 = 54000`).
- **P95 < 100 ms** — Phase 2 Success Criterion #2.
- `-wal` sidecar file size < 20 MB at end (RESEARCH Pitfall 1 sanity).

Default runs **skip** this describe block via
`describe.skipIf(process.env.LOAD_TEST !== '1')`.

## How to run

### Default suite (excludes load test)
```bash
npm run test:integration
```

### Load test only, on-demand (~10 min)
```bash
LOAD_TEST=1 npm run test:integration -- persistence/load
```

Expected console output (for CI log parsers):
```
[load] samples=60000 P50=<X>ms P95=<Y>ms P99=<Z>ms
[load] WAL size at end = <N> bytes
```

### All persistence integration tests (default, excludes load)
```bash
npm run test:integration -- test/integration/persistence/
```

## Why gated

Running the 10-minute load test on every push would wedge the default
pipeline. The assertion set exists primarily as a **phase gate**: the
Phase 2 verifier runs it once before sign-off via the command above.
Day-to-day invariant drift is caught by `rehydration.test.ts` and
`migration-forward-only.test.ts`, which both run in the default suite.
