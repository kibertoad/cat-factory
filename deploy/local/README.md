# deploy/local — run cat-factory on your own machine

This package is the **local-mode** deployment: the whole product running on a
developer's laptop. The reusable logic lives in
[`@cat-factory/local-server`](../../backend/runtimes/local) — the Node.js facade
([`@cat-factory/node-server`](../../backend/runtimes/node): shared Hono app +
Drizzle/Postgres + pg-boss) with two local differentiators:

- **Agent jobs run as local Docker/Podman containers.** Each repo-operating step
  (coder, mocker, playwright, blueprints, tester, fixer, ci-fixer, conflict-resolver,
  merger) is launched as its own `docker run` of the executor-harness image — the same
  image the Cloudflare Worker runs per-run Containers from — via the
  `LocalDockerRunnerTransport`. No Cloudflare and no self-hosted runner pool required.
- **GitHub is reached via a personal access token** (`GITHUB_PAT`) instead of a GitHub
  App. The agent containers clone, push branches and **open real PRs on github.com**
  with that token.

Persistence is a **local Postgres** (the bundled `docker-compose.yml`).

## Prerequisites

- Docker (or Podman) running locally — used both for Postgres and for the per-job
  agent containers.
- The executor-harness image available locally. Pull the published GHCR image, or
  build it from source:
  ```sh
  docker build -t cat-factory-executor:local ../../backend/internal/executor-harness
  ```
- A GitHub PAT (fine-grained, scoped to your target repo(s), with contents +
  pull-requests write).

## Run it

```sh
cp .env.example .env          # then fill in GITHUB_PAT (+ LOCAL_HARNESS_IMAGE)
pnpm db:up                    # start the local Postgres
pnpm start                    # migrate + boot the service on :8787
```

`startLocal()` connects to `DATABASE_URL`, runs the schema migration, boots pg-boss +
the durable execution worker, and serves the shared HTTP API. Agent jobs reach the
LLM through this service's `/v1` proxy (no provider key needs to live in the
container), addressed at `host.docker.internal` from inside Docker.

`pnpm start` serves the JSON API only. For the board UI run the frontend too (next
section). You don't need `GITHUB_PAT` to boot: with it unset the service starts and the
UI shows a banner linking to GitHub's token page (scopes pre-selected); set the token
and restart to actually run repo-operating agent steps.

`ENCRYPTION_KEY` is generated per process when unset, so a stock boot works with no
config. If you DO set it, it must be valid base64 of at least 32 bytes (e.g.
`openssl rand -base64 32`); a non-base64 value like `dummy` fails the cipher at boot
with `InvalidCharacterError`. Set it explicitly to keep encrypted-at-rest credentials
(integration tokens, personal subscriptions) decryptable across restarts; otherwise a
fresh per-process key means they have to be re-entered after each restart.

## Open the UI

The board is a separate SPA ([`deploy/frontend`](../frontend)), not served by this
process. Run it pointed at this API:

```sh
cd ../frontend
pnpm dev                      # Nuxt dev server on http://localhost:3000
```

`apiBase` defaults to `http://localhost:8787` (this service), so no extra config is
needed when you keep the default `PORT`. Open http://localhost:3000. CORS allows any
origin when `CORS_ALLOWED_ORIGINS` is unset (the local default), and the auth gate is
open in local mode, so the board loads straight away.

## How a target repo is linked

Container agent steps resolve which repo to operate on from the `github_repos` /
`github_installations` projection (the same as the cloud facades). Local mode has no
GitHub-App connect flow, so those rows are seeded from the PAT instead. Two ways:

### From the board (recommended)

With `GITHUB_PAT` set, the GitHub integration works through the token: the workspace is
treated as connected automatically (a synthetic installation is provisioned from the
PAT), so the sidebar's "Add from existing repo" button is available. It lists the repos
the PAT can access (via `/user/repos`); pick one to create a `ready` service frame linked
to that repo. No connect step, no App.

### From the CLI

Or seed the rows directly for a specific frame:

```sh
# node dist/link-repo.js <workspaceId> <frameBlockId> <owner/repo>
pnpm --filter @cat-factory/local-server link:repo ws_123 blk_frame your-org/your-repo
```

It reads `GITHUB_PAT` + `DATABASE_URL` from the environment, fetches the repo's
metadata with the PAT, and upserts the installation + repo rows (linked to the frame).
It shares the synthetic installation id with the board flow, so the two agree.

## Networking notes

- The harness inside a job container reaches this service's LLM proxy at
  `http://host.docker.internal:<PORT>/v1`. On Linux the transport publishes that alias
  with `--add-host=host.docker.internal:host-gateway`; on Docker Desktop it already
  resolves.
- github.com is reached directly from the job container with the PAT.

## Merge lifecycle

A full pipeline runs end to end on real GitHub: the harness opens a real PR with the
PAT, the `ci` gate reads the PR's **real GitHub Actions** check runs (and dispatches a
ci-fixer container on failure), and the merger step **merges the PR for real** once it
clears the task's merge threshold — all via the PAT. A merge that needs review (or a
pipeline with no merger) raises an in-app notification instead.

## Running the Tester locally (Docker-in-Docker)

The `tester` step runs the project's suite and returns a structured greenlight/loop
report; a withheld greenlight loops a `fixer` (up to the task's merge-preset attempt
budget) and re-tests. It can stand the service's dependencies up two ways, chosen by
the task's **Test environment** config (inspector → Agent configuration, or on the
task-creation form):

- **Ephemeral** (default) — test against a provisioned environment URL; nothing is
  stood up locally. Zero extra setup.
- **Local** — the Tester runs `docker compose up` for the service's dependencies
  **inside its own job container** (Docker-in-Docker), so they sit on that container's
  `localhost`. To use it you must, on the **service frame** (inspector → Test
  infrastructure), either set the **docker-compose path** or tick **No infra
  dependencies** — a local-mode Tester pipeline refuses to start until one is set.

Because the job runs Docker inside Docker, in local mode the Tester's container is
launched **`--privileged`** so its in-container daemon can start. This is the only kind
that gets elevated; every other agent job runs unprivileged. If your runtime can run
nested containers without it (e.g. rootless Podman), set
`LOCAL_DOCKER_PRIVILEGED_TEST_JOBS=false`. Standing the infra up is best-effort: if the
in-container daemon can't start, the Tester is told and runs what it can rather than
failing the job.

## Container sizing & the `docker` provider

Local mode never touches a cloud. A service's **cloud provider** should be set to
**`docker`** (inspector → Test infrastructure), and its **instance size** maps straight
to the per-job container's resource limits on your host daemon:

| size   | `--memory` | `--cpus` |
| ------ | ---------- | -------- |
| small  | 1g         | 1        |
| medium | 2g         | 2        |
| large  | 4g         | 4        |
| xlarge | 8g         | 8        |

New services inherit the active account's **default cloud provider** (set it once from
the account menu — e.g. to `docker` for a local install); a service can still override
it per-frame.
