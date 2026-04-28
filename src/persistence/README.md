# persistence

SQLite-backed persistence adapters for graph state, runs, and events.

This directory owns database setup, migrations, schema-mirroring row types, row/entity codecs, graph persistence, and the narrowed `Store` implementation.
It does not own domain invariants; those stay in [core](../core/README.md) and orchestrator port contracts.

## Layout

- `db.ts` — opens SQLite, applies pragmas, and runs migrations.
- `migrations/` — schema bootstrap and migration registration.
- `queries/` — row shapes that mirror on-disk columns exactly, including `snake_case` and DB timestamps.
- `codecs.ts` — row/entity conversion plus JSON-in-TEXT boundaries.
- `feature-graph.ts` — `PersistentFeatureGraph`, which rehydrates an `InMemoryFeatureGraph` and persists graph diffs transactionally.
- `sqlite-store.ts` — `Store` implementation for `agent_runs` and `events`.

## Boundary reminders

- `PersistentFeatureGraph` owns milestone/feature/task/dependency persistence. `SqliteStore` owns run/event CRUD only.
- Keep row types schema-shaped and persistence-local. Higher-level naming and lifecycle rules belong in `@core/*`.
- When adding persisted fields, update the migration, row type, codec, and whichever graph/store write path owns that entity.
- Current baseline treats legacy `executing_repair` feature work phases as unsupported vocabulary; older `.gvc0/state.db` files should be dropped or migrated before use.

## See also

- [Architecture / Persistence](../../docs/architecture/persistence.md)
- [core](../core/README.md)
- [orchestrator](../orchestrator/README.md)
