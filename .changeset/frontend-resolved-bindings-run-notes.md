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
- **Run/step detail projection + run-start note**: the engine stamps BOTH the resolved bindings
  (`ExecutionInstance.frontendBindings`) and the non-fatal advisories (`ExecutionInstance.notes`:
  duplicate env vars, or a partial-live set where some bound services fall back to WireMock) on the
  run ONCE at start — the SPA-visible mirror of the harness's own `buildInfraNotes`. A `tester-ui`
  step's detail projects the FROZEN start-time bindings (so a finished run shows what it actually
  drove against, not a live re-resolution that could disagree with the co-located note after the
  envs are torn down); the run-start note shows on any step detail of a frontend-frame run. Both
  ride in the run's `detail` JSON (no migration) and round-trip identically on D1 ⇄ Postgres.

No wire/behaviour break: the notes field is optional, the moved helpers are re-exported, and a
non-frontend run is unaffected.
