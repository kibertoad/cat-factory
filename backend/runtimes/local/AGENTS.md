# `@cat-factory/local-server` — local-mode runtime facade

> Directory `backend/runtimes/local`, published as `@cat-factory/local-server`.

The Node facade (`@cat-factory/node-server`) with **two swaps** so a developer runs the whole
product on their own machine: agent jobs run as **per-run local containers**
(Docker/Podman/OrbStack/Colima/Apple), and GitHub is reached via a **PAT** instead of a GitHub
App. Reuses ALL of Node's persistence / pg-boss / gateways unchanged — only the runner
transport + the GitHub token/client seams differ.

**Entry:** `src/index.ts` (`startLocal()` / `buildLocalContainer`); `src/main.ts`.

**Where things live:**

- `LocalContainerRunnerTransport.ts` — the per-run container transport (the local analogue of
  the CF Container transport + the runner-pool transport, over the same `RunnerTransport` port).
- `runtimes/` — the `ContainerRuntimeAdapter`s per engine (docker CLI shared by
  Docker/Podman/OrbStack/Colima; a separate Apple `container` adapter), selected by
  `LOCAL_CONTAINER_RUNTIME`. Two contracts an adapter is easy to get wrong: `endpoint()`
  resolves an EXITED container to `undefined` (that is what lets the transport remove and
  re-create it) yet still throws for a fault against a LIVE one, and `exitState()` reports how
  a stopped container ended so a mid-run death leaves a post-mortem behind.
- `github.ts`, `link-repo.ts` / `linkRepo.ts`, `installations.ts` — the PAT-backed GitHub
  client (`createLocalGitHubClient`) + the repo-projection seeding (`linkRepo`).
- `container.ts` — threads the transport + GitHub seams into Node's `buildNodeContainer`.
- `mothership.ts` + `sqlite/` — **mothership mode** (`LOCAL_MOTHERSHIP_URL`): a third boot shape
  with NO local Postgres, where org/durable state is served by a hosted cat-factory over the
  `/internal/*` machine API and only credentials/settings/the work queue/**telemetry** stay on the
  laptop in `node:sqlite`. `mothershipPropagator.ts` (outbound engine events) and
  `mothershipSubscriber.ts` (inbound per-workspace subscriptions, opened on demand from the local
  hub's rooms) are the two halves of its real-time channel. Read
  `docs/initiatives/mothership-mode.md` before touching any of it — and `CLAUDE.md` → "Every new
  feature ships MOTHERSHIP-READY" before adding a repository method anywhere in the backend.
- `sqlite/telemetryStore.ts` + `telemetryRetention.ts` — the LOCAL-FIRST telemetry bucket (per-call
  LLM metrics, agent-context snapshots, performed web searches, the provisioning log, modeled quota
  cycles) and its hourly prune. Layered over the remote registry by `composeMothership`, so every
  consumer resolves it with no per-consumer wiring; the bucket's membership is declared once in
  `@cat-factory/server`'s `LOCAL_FIRST_PERSISTENCE_REPOSITORIES`, which TYPES the composition —
  adding a telemetry repository without listing it there fails to compile rather than silently
  resolving a remote proxy the allow-list will only answer `unknown_method`.
- `harnessImage.ts` — `RECOMMENDED_HARNESS_IMAGE`, the executor image tag local mode pulls at
  boot (must stay a matched set with the backend — `CLAUDE.md` → "Releases & changesets").

**See also:** `deploy/local/README.md`, `CLAUDE.md` → "Multi-runtime facades".
