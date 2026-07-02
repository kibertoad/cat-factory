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
  `LOCAL_CONTAINER_RUNTIME`.
- `github.ts`, `link-repo.ts` / `linkRepo.ts`, `installations.ts` — the PAT-backed GitHub
  client (`createLocalGitHubClient`) + the repo-projection seeding (`linkRepo`).
- `container.ts` — threads the transport + GitHub seams into Node's `buildNodeContainer`.
- `harnessImage.ts` — `RECOMMENDED_HARNESS_IMAGE`, the executor image tag local mode pulls at
  boot (must stay a matched set with the backend — `CLAUDE.md` → "Releases & changesets").

**See also:** `deploy/local/README.md`, `CLAUDE.md` → "Multi-runtime facades".
