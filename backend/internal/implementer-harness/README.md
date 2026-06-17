# @cat-factory/implementer-harness

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
   to `AGENTS.md`, and point Pi at the Worker's LLM proxy via
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
| `src/pi.ts`        | Pi provider config, non-interactive run, JSON-line event + todo-progress parsing, `AGENTS.md` guidance. |
| `src/git.ts`       | clone / branch / commit / push + GitHub PR creation; bootstrap history reset + force-push.              |
| `src/bootstrap.ts` | The `/bootstrap` handler (clone-or-empty → adapt → reinit + force-push).                                |
| `src/blueprint.ts` | The `/blueprint` handler (decompose → render `blueprints/` → commit on branch).                         |
| `src/embed.ts`     | Bundled assets/templates written into the workspace.                                                    |
| `src/logger.ts`    | Structured logging.                                                                                     |

## Runner lifecycle knobs

Read from the environment inside the container (also honoured by a self-hosted
runner):

| Env var               | Default         | Effect                                                      |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `PORT`                | `8080`          | HTTP port the harness listens on.                           |
| `JOB_MAX_DURATION_MS` | `3600000` (60m) | Hard ceiling on a job's wall-clock time; force-fails after. |
| `JOB_INACTIVITY_MS`   | `600000` (10m)  | Kills a hung agent that produces no output for this long.   |

## Build / test

```sh
pnpm --filter @cat-factory/implementer-harness build      # tsc → dist/
pnpm --filter @cat-factory/implementer-harness test       # unit tests
docker build -f Dockerfile .                              # the container image
```

The build context is just this package, so its `tsconfig.json` is intentionally
self-contained.

## Published image (GHCR)

This package is not published to npm; instead its **Docker image** is published to
GHCR by [`.github/workflows/docker-publish.yml`](../../../.github/workflows/docker-publish.yml),
gated on changes that affect the image (`src/**`, `Dockerfile`, `tsconfig.json`,
`package.json`). It is tagged with the package `version`, the commit `sha-…`, and
`latest`:

```
ghcr.io/<owner>/cat-factory-implementer:<version>
```

A backend deployment references it from `wrangler.toml`
(`[[containers]] image = "ghcr.io/<owner>/cat-factory-implementer:<version>"` — see
[`deploy/backend`](../../../deploy/backend)). The worker library's own test/dev
`wrangler.toml` still references this `Dockerfile` by local path so the acceptance
suite can build it. Because the version is the image tag, **bump this package via a
changeset whenever you change image content** (see [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)).
