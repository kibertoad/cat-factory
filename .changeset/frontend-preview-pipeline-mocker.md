---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/contracts': patch
---

feat(frontend): `pl_frontend` pipeline + frontend-aware mocker (slice 4 of the
frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

Builds on slice 3's self-contained UI-test infra with the pipeline that drives it and a mocker
that authors the mocks it needs.

- **`pl_frontend` built-in pipeline** (`coder → reviewer → mocker → tester-ui → conflicts → ci →
merger`). For a `type: 'frontend'` frame the engine already resolves the frame's
  `frontendConfig` + backend bindings and stands the app + WireMock up in one container (slice 3),
  so this pipeline is just the step order that exercises it end to end: implement → review → mock
  → browser-test → the standard mergeability/CI/merge tail. Labelled `experimental` — two
  deploy-/keying-time steps remain (the `ui`-image per-step routing, and keying a bound service's
  ephemeral env by its FRAME id so a live-service binding resolves instead of falling back to
  WireMock); a mock-only frontend already runs fully self-contained today.
- **Frontend-aware mocker.** When a `mocker` step runs on a task under a `frontend` frame, its
  user prompt now carries a frontend section: author WireMock stub mappings under the frontend
  repo's mock dir in WireMock's `--root-dir` layout (`<dir>/mappings/*.json` + `<dir>/__files/`)
  for exactly the upstreams the harness points at WireMock (every binding with no live service
  under test), and do NOT wire a docker-compose stack — the platform serves the app + WireMock
  directly. The live service(s) under test are named and explicitly excluded from mocking. A
  backend-service mocker run is unchanged (the section is absent without a resolved frontend
  context). The section explicitly OVERRIDES the docker-compose stand-up guidance in the
  (backend-oriented) mocker role prompt so the two do not contradict for a frontend run, and the
  default WireMock root (`mocks/`) is now the shared `DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH` constant
  in `@cat-factory/contracts` rather than a private literal.
