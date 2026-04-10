# src

Application entry and composition root.

This directory owns process startup, config loading, and wiring the concrete subsystems into the runnable gvc0 application. It should stay thin and avoid re-implementing subsystem logic.

Guidelines:
- `@core/*` owns pure workflow/domain contracts and scheduling/state rules.
- Adapter packages own adapter-specific ports, result shapes, reference types, and implementations for their side effects.
- `@orchestrator/*` may depend on adapter-owned contract surfaces, but not on concrete adapter implementations.
- Package barrels should be curated public APIs. Export only intended public surfaces; do not use blanket `export *` barrels.
- Prefer package barrels such as `@git` for cross-package public contract imports. Internal package files should import local contract modules directly rather than routing through their own public barrel.
