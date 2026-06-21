# deploy/local — run cat-factory on your own machine

This package is the **local-mode** deployment: the whole product running on a
developer's laptop. The reusable logic lives in
[`@cat-factory/local-server`](../../backend/runtimes/local) — the Node.js facade
([`@cat-factory/node-server`](../../backend/runtimes/node): shared Hono app +
Drizzle/Postgres + pg-boss) with two local differentiators:

- **Agent jobs run as local Docker/Podman containers.** Each repo-operating step
  (coder, mocker, playwright, blueprints, ci-fixer, conflict-resolver, merger) is
  launched as its own `docker run` of the executor-harness image — the same image the
  Cloudflare Worker runs per-run Containers from — via the
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

## How a target repo is linked

Container agent steps resolve which repo to operate on from the `github_repos` /
`github_installations` projection (the same as the cloud facades). Local mode has no
GitHub-App connect flow, so seed those rows for your target repo with the bundled
helper before running a pipeline against a board service frame:

```sh
# node dist/link-repo.js <workspaceId> <frameBlockId> <owner/repo>
pnpm --filter @cat-factory/local-server link:repo ws_123 blk_frame your-org/your-repo
```

It reads `GITHUB_PAT` + `DATABASE_URL` from the environment, fetches the repo's
metadata with the PAT, and upserts the installation + repo rows (linked to the frame).

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
