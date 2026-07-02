---
"@cat-factory/executor-harness": patch
"@cat-factory/local-server": minor
"@cat-factory/cli": patch
---

Local native mode: default `LOCAL_HARNESS_ENTRY` to a bundled harness (no more manual path)

Native execution (`LOCAL_NATIVE_AGENTS`) previously required `LOCAL_HARNESS_ENTRY` to be set
to a filesystem path to the executor-harness server entry, which only existed inside a full
monorepo checkout — so consumers installing `@cat-factory/*` from npm had no stable target.

- `@cat-factory/executor-harness` is now **published** (was `private`). Its `.` export is the
  zero-dependency `dist/server.js` HTTP server that native mode spawns via `node <entry>`.
- `@cat-factory/local-server` now depends on it and **auto-resolves** the entry via
  `require.resolve('@cat-factory/executor-harness')` when `LOCAL_HARNESS_ENTRY` is unset — so a
  fresh install runs native mode out of the box, mirroring how an unset `LOCAL_HARNESS_IMAGE`
  falls back to the pinned recommended image. Setting `LOCAL_HARNESS_ENTRY` still overrides it
  (for a custom or source-checkout build).
- `cat-factory init` (`@cat-factory/cli`) no longer treats the entry as required: it is written
  commented (optional override) and the "set it before starting" warnings are gone.
