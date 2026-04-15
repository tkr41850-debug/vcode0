# app

Application lifecycle wrapper around composed ports.

This directory owns thin app-level lifecycle glue: start selected mode, show UI, stop lifecycle, and always dispose UI on shutdown.

Current surface:
- `GvcApplication` — starts composed lifecycle, then shows UI; stops lifecycle, then disposes UI.
- `ApplicationLifecycle` — injectable start/stop contract implemented by composition root.
