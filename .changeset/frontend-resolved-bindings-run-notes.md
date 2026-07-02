---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/kernel': patch
'@cat-factory/server': patch
---

Frontend UI-test bindings: surface how each backend binding resolves + a non-fatal run-start note.

- **Shared resolution helpers moved to `@cat-factory/contracts`** (next to `frontendOriginsForService`)
  so the SPA and the backend share ONE source of truth: `resolveFrontendBindings`,
  `indexLiveServiceEnvUrls`, `boundServiceFrameIds`, the `ResolvedFrontendBinding`/`LiveEnvHandle`
  types, and a new pure `buildFrontendRunNotes`. Orchestration re-exports them, so existing importers
  are unchanged.
- **Inspector resolved-binding visibility**: `FrontendConfig.vue` now shows, live, how each backend
  binding resolves — `envVar → a bound service's live ephemeral URL | mocked (WireMock)` — mirroring
  what a UI-test run resolves, plus a warning for duplicate env vars. Backed by a new lightweight
  `environments` store over `GET /workspaces/:ws/environments`.
- **Run/step detail projection + run-start note**: a `tester-ui` step's detail projects the same
  resolved bindings, and the engine stamps non-fatal advisories on the run at start
  (`ExecutionInstance.notes`: duplicate env vars, or a partial-live set where some bound services
  fall back to WireMock) — the SPA-visible mirror of the harness's own `buildInfraNotes`. The notes
  ride in the run's `detail` JSON (no migration) and round-trip identically on D1 ⇄ Postgres.

No wire/behaviour break: the notes field is optional, the moved helpers are re-exported, and a
non-frontend run is unaffected.
