# @cat-factory/executor-harness

The payload that runs **inside** a per-run Cloudflare Container (or a
[self-hosted runner](../../docs/runner-pool-integration.md)) to perform real
repo work with the [Pi coding agent](https://github.com/earendil-works/pi).

It is a thin TypeScript wrapper — a `node:http` server on `:8080` — that the
Worker drives over a small **job protocol**. Jobs run **asynchronously**: a `POST`
accepts the job and returns immediately with a `jobId`; the driver then polls
`GET /jobs/{id}` for live progress and the terminal result.

## Table of contents

- [Job protocol](#job-protocol)
- [What a job does](#what-a-job-does)
- [No secrets in the image](#no-secrets-in-the-image)
- [Layout](#layout)
- [Runner lifecycle knobs](#runner-lifecycle-knobs)
- [Build / test](#build--test)

## Job protocol

| Method & path     | Purpose                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /health`     | Liveness — `{ "status": "ok" }`.                                                                                       |
| `POST /run`       | Start (or re-attach to) an **implementation** job (`coder` / `mocker` / `playwright`). Returns `202 { jobId, state }`. |
| `POST /bootstrap` | Start a **repo-bootstrap** job (adapt a reference architecture → force-push a new repo).                               |
| `POST /blueprint` | Start a **blueprint** job (decompose a repo → write the in-repo `blueprints/` map, commit on a branch).                |
| `GET /jobs/{id}`  | Poll any job; returns the **job view** (`state`, optional `progress {completed,inProgress,total}`, `result`, `error`). |

All jobs run in a generic `JobRegistry` (`src/runner.ts`) keyed by `jobId`, so a
replayed `POST` **re-attaches** to the running job rather than starting a
duplicate (the durable driver's retries/replays are safe). Pi's todo-tool counts
are surfaced as `progress` while a job runs. The exact request/response shapes
cat-factory sends are documented in
[`docs/runner-pool-integration.md`](../../docs/runner-pool-integration.md).

## What a job does

The implementation job (`POST /run`) is the canonical sequence:

1. **clone** the target repo (shallow) with a short-lived GitHub installation token,
2. write the composed system prompt (role + the block's best-practice fragments)
   to Pi's **global** context file `~/.pi/agent/AGENTS.md` (outside the checkout,
   so it never lands in a commit and never clobbers a repo's own `AGENTS.md` —
   Pi reads and concatenates both), and point Pi at the Worker's LLM proxy via
   `~/.pi/agent/models.json` (provider `proxy`, `api: openai-completions`),
3. **run Pi** non-interactively (`pi -p --mode json --model proxy/<model> --approve`),
4. **commit, push** a branch and **open a PR**, returning `{ prUrl, branch, summary }`.

Bootstrap differs at the ends — it may start from an empty dir, and **resets
history to one commit and force-pushes** the default branch instead of opening a
PR. Blueprint **commits onto a branch** (no history reset) and returns the tree.

## No secrets in the image

The image (built from the `Dockerfile`, base `node:26-trixie-slim`) contains
only `git` + the Pi CLI + this compiled wrapper — **no API keys, no GitHub
credentials**. Per job, the Worker passes a short-lived GitHub token and a
signed, model-locked LLM-proxy **session token** in the request body. Pi reaches
models only through the Worker proxy, which injects the real provider key (qwen /
Kimi / DeepSeek) and meters spend. The provider key never enters the container.

## Layout

| File               | Responsibility                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/server.ts`    | HTTP entry point; routes `/health`, `/run`, `/bootstrap`, `/blueprint`, `/jobs/{id}`.                   |
| `src/runner.ts`    | `JobRegistry` — async job lifecycle, idempotent on `jobId`, progress tracking.                          |
| `src/job.ts`       | Request types + validators for the job specs.                                                           |
| `src/pi.ts`        | Pi provider config, non-interactive run, JSON-line event + todo-progress parsing, global `AGENTS.md` guidance. |
| `src/git.ts`       | clone / branch / commit / push + GitHub PR creation; bootstrap history reset + force-push.              |
| `src/bootstrap.ts` | The `/bootstrap` handler (clone-or-empty → adapt → reinit + force-push).                                |
| `src/blueprint.ts` | The `/blueprint` handler (decompose → render `blueprints/` → commit on branch).                         |
| `src/embed.ts`     | Bundled assets/templates written into the workspace.                                                    |
| `src/agent-runner.ts` | The subscription-harness runners (`runClaudeCode` / `runCodex`) — talk direct to the vendor with a leased OAuth token, lift per-turn usage/telemetry off the CLI event stream. |
| `src/transcript-retention.ts` | Lifts the CLI session transcripts (`projects/` / `sessions/`) out of the isolated, credential-bearing config home before it is deleted, and prunes them on a TTL (debugging artifact retention). |
| `src/logger.ts`    | Structured logging.                                                                                     |

## Runner lifecycle knobs

Read from the environment inside the container (also honoured by a self-hosted
runner):

| Env var               | Default         | Effect                                                      |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `PORT`                | `8080`          | HTTP port the harness listens on.                           |
| `JOB_MAX_DURATION_MS` | `3600000` (60m) | Hard ceiling on a job's wall-clock time; force-fails after. |
| `JOB_INACTIVITY_MS`   | `600000` (10m)  | Kills a hung agent that produces no output for this long.   |
| `HARNESS_TRANSCRIPT_TTL_MS` | `259200000` (3d) | How long lifted subscription-CLI session transcripts are kept before the retention sweep prunes them. |
| `HARNESS_TRANSCRIPT_ROOT`   | `<tmpdir>/cf-agent-transcripts` | Where retained session transcripts are moved to (one dir per run). Meaningful only on a reused (warm-pool) container; a per-run container is torn down with the job. The TTL sweep deletes only dirs it created (each carries a `.cf-retained` marker), so pointing this at a shared directory never touches unrelated content — though a dedicated dir is still recommended. An override on a different filesystem than the config home falls back to copy-then-remove. |

## Build / test

```sh
pnpm --filter @cat-factory/executor-harness build      # tsc → dist/
pnpm --filter @cat-factory/executor-harness test       # unit tests
docker build -f Dockerfile .                              # the container image
```

The build context is just this package, so its `tsconfig.json` is intentionally
self-contained.

## Published image (GHCR + Docker Hub)

This package is published to npm (its zero-dependency `dist/server.js` is the
entry `@cat-factory/local-server` spawns in local native mode). In addition, its
**Docker image** is published publicly, multi-arch (`linux/amd64` +
`linux/arm64`), to **both GHCR and Docker Hub** so anyone can pull it without
building from source:

```
ghcr.io/<owner>/cat-factory-executor:<version>
docker.io/<org>/cat-factory-executor:<version>
```

Each is tagged with the package `version`, the commit `sha-…`, and `latest`.

**CI** does this automatically:
[`.github/workflows/docker-publish.yml`](../../../.github/workflows/docker-publish.yml)
republishes on every push to `main` that touches image content (`src/**`,
`Dockerfile`, `tsconfig.json`, `package.json`). Docker Hub is gated on the
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets; without them it publishes
to GHCR only.

**Manually** (on demand, or to publish from a fork under your own namespaces):

```sh
# Log in first (one per registry you target):
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
echo "$DOCKERHUB_TOKEN" | docker login -u <dockerhub-user> --password-stdin

pnpm --filter @cat-factory/executor-harness run image:publish
```

The script ([`scripts/publish-image.sh`](./scripts/publish-image.sh)) builds the
multi-arch image once and pushes it to the selected registries. Override defaults
via env vars (`REGISTRIES`, `GHCR_OWNER`, `DOCKERHUB_ORG`, `TAG`, `PUSH_LATEST`,
`PLATFORMS`, `EXTRA_CA`) — see the header of the script. Example: GHCR only —
`REGISTRIES=ghcr pnpm --filter @cat-factory/executor-harness run image:publish`.

A backend deployment references the image from `wrangler.toml`
(`[[containers]] image = "ghcr.io/<owner>/cat-factory-executor:<version>"` — see
[`deploy/backend`](../../../deploy/backend)); a self-hosted runner pool pulls the
same image (see [`docs/runner-pool-integration.md`](../../docs/runner-pool-integration.md)).
The worker library's own test/dev `wrangler.toml` still references this
`Dockerfile` by local path so the acceptance suite can build it. Because the
version is the image tag, **bump this package via a changeset whenever you change
image content** (see [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)).
