---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/local-server': patch
'@cat-factory/contracts': patch
---

Self-contained frontend UI-test infra (slice 3 of the frontend-preview + in-context
UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

A `tester-ui` running on a task under a `type: 'frontend'` frame now builds and serves the
frontend, stands WireMock up for its OTHER backend upstreams, and drives the UI tests against
the two together — all as localhost processes in the one container (no Docker-in-Docker), so
it works on Cloudflare and Apple `container` too.

- **Harness**: a new `frontend` variant of the tester infra spec (`kind: 'frontend'`) that
  installs, builds (injecting the resolved backend URLs at build time, or a `window.env` shim
  for runtime injection), starts WireMock seeded from the frontend repo's mappings dir, serves
  the built app, health-checks it, and points the agent at it. The `ui` image gains pnpm/yarn
  (corepack), a static file server (`serve`), and a headless JRE + WireMock standalone
  (executor-harness image bumped to 1.28.0).
- **Backend**: `AgentRunContext` carries a resolved `frontend` slice (the frame's
  `frontendConfig` plus its backend bindings resolved to concrete upstreams — a bound service's
  live ephemeral env URL for the service under test, else a WireMock mock). The engine's
  `testerInfraSpec` turns it into the harness spec, and the tester-infra start gate refuses a
  frontend UI test that has no live service under test. Empty-envVar bindings are filtered.

BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
(`service` | `frontend`); the default backend-service tester shape is unchanged.
