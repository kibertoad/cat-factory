---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/contracts': patch
'@cat-factory/app': patch
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
  frontend UI test only when it binds a live-backend `service` with none actually live (a
  mock-only / no-backend frontend passes — WireMock + the static server fully stand it up).
  Empty-envVar bindings are filtered.
- **Hardening** (review follow-ups): the harness's WireMock / serve child processes get an
  `'error'` listener (a spawn failure is captured, not an uncaught crash of the job server),
  WireMock is now health-checked alongside the served app (a dead mock becomes a prompt note,
  not a test-time ECONNREFUSED), reserved env-var names (`PATH`, `NODE_OPTIONS`, …) are dropped
  from the injected build env, and a configured `servePort` that collides with a reserved
  in-container port (8080 harness job server, 8089 WireMock) falls back to the default. The
  inspector's servePort placeholder now shows 4173. Shared `pathExists` / log-capture helpers
  are de-duplicated in the harness. The frontend UI-test gate's batch env read
  (`environmentRegistryRepository.listByWorkspace`) is added to the mothership remote-persistence
  allow-list so the gate resolves in mothership mode.
- **Hardening (second review round)**: the frontend stand-up now feeds the run's inactivity
  watchdog with a heartbeat while it installs/builds/serves — a real frontend's `install` +
  `build` can exceed the 10-min inactivity window, and the (activity-silent) stand-up would
  otherwise be killed mid-build with a misleading "likely hung". `serveMode: 'command'` now also
  forwards the resolved backend URLs (`env`) to the serve process, so a runtime-reading
  dev/preview server sees them (previously only `PORT` was passed). Reserved env-var names are
  now also dropped in the backend infra-spec builder (defence in depth, not just the harness).
  The `mockMappingsPath` docs + inspector hint clarify WireMock's `--root-dir` layout (stubs go
  in a `mappings/` subfolder), and the env-injection hint notes the build-tool prefix caveat
  (e.g. Vite only exposes `VITE_*`). The UI-tester prompt flags a live-backend CORS failure as an
  infra gap rather than an app defect.
- **Hardening (third review round)**: the frontend stand-up now runs in the run's SERVICE
  SUBTREE (`workDir`), not the clone root — a monorepo frontend's `package.json` / `outputDir` /
  `mocks/` live under its own subdirectory, so installing, building, serving and seeding WireMock
  from the repo root would have targeted the wrong directory (the docker-compose stand-up still
  runs at the root, where its repo-relative `composePath` resolves). The harness now bounds
  frontend `servePort` / `wiremockPort` to 1..65535 at its untrusted-body boundary (an
  out-of-range port can never bind, so it falls back to the default). The reserved-env filter —
  in BOTH the harness parse and the backend infra-spec builder — grows the `NODE_EXTRA_CA_CERTS`
  / `BASH_ENV` / `ENV` / `SHELL` / `IFS` names plus the `npm_config_*` and `GIT_*` FAMILIES, so a
  binding that reconfigures the package manager, git, or the TLS trust store during the build is
  dropped rather than injected. Runtime env injection under `serveMode: 'command'` now warns
  (the `window.env` shim is only served in static mode; the forwarded `env` covers the command
  server), and a failed shim write is logged instead of silently swallowed. `AgentContextBuilder`
  gains `resolveServiceFrame` so the frontend-config resolution reuses the frame row the walk
  already loaded instead of re-fetching it. Fixes the `Lint & format` failure (an unnecessary
  `?? {}` empty-fallback spread in the serve env).

BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
(`service` | `frontend`); the default backend-service tester shape is unchanged.
