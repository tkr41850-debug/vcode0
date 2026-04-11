# persistence

Persistence interfaces for the SQLite-backed store.

This directory owns the persistence-local contract surface: schema-mirroring row types, migration interfaces, JSON/TEXT codecs, and the `Store` adapter skeleton. Row types intentionally mirror database columns exactly, including timestamps and snake_case names; higher-level domain authority stays in `src/core/` and `src/orchestrator/ports/`.
