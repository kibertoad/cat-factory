# deploy/local — run cat-factory on your own machine

This package is the **local-mode** deployment: the whole product running on a
developer's laptop. The reusable logic lives in
[`@cat-factory/local-server`](../../backend/runtimes/local) — the Node.js facade
([`@cat-factory/node-server`](../../backend/runtimes/node): shared Hono app +
Drizzle/Postgres + pg-boss) with two local differentiators:

- **Agent jobs run as local containers.** Each repo-operating step (coder, mocker,
  playwright, blueprints, tester, fixer, ci-fixer, conflict-resolver, merger) is launched
  as its own container of the executor-harness image — the same image the Cloudflare
  Worker runs per-run Containers from — via the `LocalContainerRunnerTransport`. Docker,
  Podman, OrbStack, Colima and Apple's `container` are all supported (see
  [Container runtimes](#container-runtimes)). No Cloudflare and no self-hosted runner
  pool required.
- **GitHub is reached via a personal access token** (`GITHUB_PAT`) instead of a GitHub
  App. The agent containers clone, push branches and **open real PRs on github.com**
  with that token.

Persistence is a **local Postgres** (the bundled `docker-compose.yml`).

## Prerequisites

- A container runtime running locally — used both for Postgres and for the per-run
  agent containers. Docker, Podman, OrbStack, Colima and Apple `container` all work; see
  [Container runtimes](#container-runtimes) for selecting and configuring one.
- The executor-harness image. You don't need to fetch it yourself — it's **pinned to the
  version this backend was released against and pulled at boot** (see
  [The executor-harness image](#the-executor-harness-image-pinned--auto-refreshed)). Only
  build it manually if you want to run your own:
  ```sh
  docker build -t cat-factory-executor:local ../../backend/internal/executor-harness
  ```
- A GitHub PAT (fine-grained, scoped to your target repo(s), with contents +
  pull-requests write).

## Run it

```sh
cp .env.example .env          # then fill in GITHUB_PAT (LOCAL_HARNESS_IMAGE is optional)
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

## The executor-harness image (pinned + auto-refreshed)

Every agent step runs in a per-run container built from the executor-harness image, which
is versioned as **its own Docker image**, separately from the `@cat-factory/*` npm
packages. `LOCAL_HARNESS_IMAGE` is **optional**: unset, `@cat-factory/local-server` uses
the image version it was released against, so the image and the backend always match — no
"too stale", no "too new" (this project has no cross-version compatibility guarantee, so a
`:latest` that's newer than your backend can break).

`startLocal()` **refreshes the resolved image at boot**, so `pnpm dev` / `pnpm start`
can't launch a stale copy — a container runtime never re-pulls a tag it already has, nor
notices a locally-built image is out of date, which is how an already-fixed harness bug
keeps reproducing. It's best-effort: an unreachable registry falls back to the local copy
rather than blocking boot.

- **Leave `LOCAL_HARNESS_IMAGE` unset** to run the matched, pinned image (recommended).
- **Set it to a custom build or a different pin** to override — boot warns if your value
  differs from the matched version, or if it's a mutable tag like `:latest`.
- **Set a bare local tag** (`cat-factory-executor:local`) to run an image you build
  yourself; boot then only checks it exists and reminds you to rebuild after harness
  changes (`docker build -t cat-factory-executor:local ../../backend/internal/executor-harness`).
- **Disable the boot refresh** with `LOCAL_HARNESS_IMAGE_REFRESH=off`.

## Using Cloudflare AI

At least one model provider must be configured or the picker shows nothing selectable
(every model comes back `available: false`) and pipelines can't start. The Cloudflare
Worker uses an in-process `workers-ai` binding for this; Node/local has no binding, so
it serves the same `workers-ai` models over Cloudflare's **REST** API. Set both:

```sh
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
# CLOUDFLARE_AI_GATEWAY=<slug>   # optional: route through an AI Gateway
```

With both set, the Cloudflare models become selectable in the picker and runnable
(inline and in agent containers), exactly like on the Worker. A direct vendor key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) works too and can be combined.

### Mint an API token

Use the dashboard's token UI and pick the built-in **Workers AI** template (it grants
`Account > Workers AI > Read`, which is all inference needs):

- https://dash.cloudflare.com/profile/api-tokens → "Create Token" → "Workers AI" → "Use template"

If you also set `CLOUDFLARE_AI_GATEWAY`, add `Account > AI Gateway > Read` to the token.

### Find your account ID

With wrangler logged in (`pnpm dlx wrangler login`), `whoami` prints the account name
and ID for the current session:

```sh
pnpm dlx wrangler whoami
```

Or read it back from the token you just minted (no wrangler needed):

```sh
curl -s https://api.cloudflare.com/client/v4/accounts \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | python -c 'import json,sys; [print(a["id"], a["name"]) for a in json.load(sys.stdin)["result"]]'
```

`ENCRYPTION_KEY` is generated per process when unset, so a stock boot works with no
config. If you DO set it, it must be valid base64 of at least 32 bytes (e.g.
`openssl rand -base64 32`); a non-base64 value like `dummy` fails the cipher at boot
with `InvalidCharacterError`. Set it explicitly to keep encrypted-at-rest credentials
(integration tokens, personal subscriptions, local-runner keys) decryptable across
restarts; otherwise a fresh per-process key means they have to be re-entered after
each restart.

## Using a local model (Ollama / LM Studio / llama.cpp / vLLM)

Run agents on a model on your own machine instead of (or alongside) a cloud provider.
The supported runners are all OpenAI-compatible, so the only difference is the default
port:

| Runner    | Default base URL            | Example install                                  |
| --------- | --------------------------- | ------------------------------------------------ |
| Ollama    | `http://localhost:11434/v1` | `ollama serve` → `ollama pull qwen2.5-coder:32b` |
| LM Studio | `http://localhost:1234/v1`  | enable the local server in the LM Studio UI      |
| llama.cpp | `http://localhost:8080/v1`  | `llama-server -m model.gguf`                     |
| vLLM      | `http://localhost:8000/v1`  | `vllm serve <model>`                             |
| Custom    | (none — supply your own)    | any OpenAI-compatible server (Jan, GPT4All, …)   |

Any model the runner serves works — e.g. `qwen2.5-coder:32b`, `qwen3-coder`,
`deepseek-coder-v2`, `llama3.3`, `gemma3` (Gemma is a _model_ served through a runner,
not a runner itself).

Local runners are configured **per user** (a runner lives on your machine) in the UI:

1. Pull/serve a model with your runner (e.g. `ollama pull gemma3`).
2. Sidebar → **Configuration → My local runners** → add a runner. Pick the type (the
   base URL prefills), optionally set a bearer key (most runners ignore auth), then
   **Test connection** — the server probes the runner's `/v1/models` and lists what's
   installed. Tick the models you want to enable.
3. Those models now appear in the model picker (as the `direct` flavour). Pin one on a
   task and run the pipeline — the agent containers reach the model through this
   service's LLM proxy (no key leaves your machine).

Local models need no API key, so no `*_API_KEY` env var. `ENCRYPTION_KEY` must be set
(local mode generates one per process; set it explicitly to keep your runner config and
optional keys across restarts). Networking: the LLM proxy runs in **this host process**,
so it reaches the runner at `localhost` directly — you only need a non-default base URL
if your runner listens elsewhere or you run the orchestrator itself in a container.

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

## Container runtimes

Agent jobs run as per-run containers spun up by the orchestrator on the host. Select the
runtime with `LOCAL_CONTAINER_RUNTIME` (default `docker`); it sets sensible defaults for
the CLI binary, the host alias the harness uses to reach this service, and whether the
Tester's local infra works:

| `LOCAL_CONTAINER_RUNTIME` | CLI         | Harness → host LLM proxy                                 | Tester local infra (Docker-in-Docker)                        |
| ------------------------- | ----------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `docker` (default)        | `docker`    | `host.docker.internal` (Desktop) / host-gateway (Linux)  | ✅                                                           |
| `orbstack`                | `docker`    | `host.docker.internal` (native)                          | ✅                                                           |
| `podman`                  | `podman`    | `host.docker.internal:host-gateway` (v4+)                | ✅ (rootless: set `LOCAL_DOCKER_PRIVILEGED_TEST_JOBS=false`) |
| `colima`                  | `docker`    | `host.lima.internal` (often needs a LAN-IP `PUBLIC_URL`) | ✅                                                           |
| `apple`                   | `container` | container's own IP; host via the vmnet gateway           | ❌ **limited mode** (see below)                              |

Notes:

- **Podman** needs fully-qualified image refs (`ghcr.io/…`, `localhost/…`) — set
  `LOCAL_HARNESS_IMAGE` accordingly. Rootless Podman nests containers without
  `--privileged`, so set `LOCAL_DOCKER_PRIVILEGED_TEST_JOBS=false`.
- **Colima / Apple** run the daemon in a VM, so `host.docker.internal` may not route to
  the Mac host where the orchestrator listens. The defaults (`host.lima.internal` for
  Colima, the `192.168.64.1` vmnet gateway for Apple) work in common setups; if a job
  container can't reach the LLM proxy, set `PUBLIC_URL` (or `LOCAL_HARNESS_HOST_ALIAS`)
  to your machine's LAN IP.
- **Apple `container` — limited mode.** Each container runs in its own lightweight VM
  with no Docker-in-Docker, so the Tester's **Local** infra mode (`docker compose up`
  inside the job container) is unavailable. A pipeline whose Tester needs it is **refused
  at start** with an actionable message. The Tester still works on Apple when the task
  uses the **Ephemeral** test environment (with an [environment provider](#ephemeral-test-environments)
  configured, so the infra is provisioned elsewhere) or the service is marked **No infra
  dependencies**. (Standing a service's compose dependencies up as sibling Apple
  containers, rather than DinD, is a possible future enhancement.)

At boot the service logs the resolved runtime, its capabilities and the host alias, and
probes that the CLI is installed — so a misconfiguration shows up immediately rather than
on the first agent job.

## Ephemeral test environments

A task's **Test environment** (inspector → Agent configuration) chooses how the Tester
gets something to test against:

- **Local** — stands the service's docker-compose dependencies up inside the job
  container (Docker-in-Docker). Self-contained and offline, but requires a runtime that
  can nest containers (every runtime except Apple `container`).
- **Ephemeral** (default) — a **deployer** step provisions an environment through a
  registered **environment provider** (your own HTTP management API — e.g. a custom
  container pool) and the Tester tests the returned URL. Runtime-independent (it's just
  HTTP), offloads the heavy infra, and is the way to run the Tester on Apple `container`.

The environment provider is identical to the cloud facades: it is available wherever
`ENCRYPTION_KEY` is set (always, in local mode) — just register a connection in the UI.
Without it, ephemeral tasks have no URL to test — fine on a DinD-capable runtime (use
Local instead), but on Apple `container` a Tester with neither a provider nor a no-infra
service is refused at start.

## Networking notes

- The harness inside a job container reaches this service's LLM proxy at
  `${PUBLIC_URL}/v1` — `PUBLIC_URL` defaults to the selected runtime's host alias (see
  [Container runtimes](#container-runtimes)). On Linux the docker-family transport
  publishes the alias with `--add-host=<alias>:host-gateway`; on Docker Desktop / OrbStack
  it already resolves.
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

On **Apple `container`** there is no Docker-in-Docker, so the **Local** mode is
unavailable and a pipeline that needs it is refused at start — use the **Ephemeral** test
environment (with a provider, see [Ephemeral test environments](#ephemeral-test-environments))
or mark the service **No infra dependencies**.

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

## Warm container pool (faster startup)

By default every run cold-starts its own harness container and clones the repo from
scratch. Set a **pool size** > 0 to keep idle harness containers **warm** and re-lease one
to each run — preferring a container that already holds the run's repo, so it does a
`git fetch` + branch switch instead of a fresh clone.

These knobs live in the **DB, not env** — configure them in the UI under **Integrations >
"Local mode"** (they used to be the `LOCAL_POOL_*` / `HARNESS_*` env vars):

| Setting                | Default                                         | Meaning                                                             |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Pool size              | `0`                                             | Max warm idle containers kept ready (`0` = pooling off).            |
| Pre-warm at boot       | `0`                                             | Containers pre-warmed when the service starts.                      |
| Max containers         | `=pool size`                                    | Hard cap on total containers; a burst beyond it uses a one-off one. |
| Idle timeout (minutes) | `10`                                            | How long an idle pooled container is kept before eviction.          |
| Workspace root         | `/workspace`                                    | Where the reused per-repo checkout lives inside the container.      |
| Keep on clean          | `node_modules,.venv,target,.gradle,.pnpm-store` | Dirs the between-run clean sweep PRESERVES (dependency caches).     |

Saving resizes the warm pool **live** — no restart needed (idle members beyond the new size
are reaped and the pool re-warms to the new minimum); in-flight runs keep the container they
already hold, and the checkout config applies to containers started after the save. Between
runs each reused checkout is **clean-swept** (`git reset --hard` + remove
every untracked/ignored file _except_ the kept dependency caches) so a prior run's garbage
never leaks into the next. **Trust boundary:** local mode is single-user, so a warm
container is reused across that one developer's runs; different repos always get separate
checkout directories (no cross-repo bleed). Pooling is supported on
Docker/Podman/OrbStack/Colima; Apple `container` ignores the pool size and keeps the
per-run path. A stale dependency cache is the residual risk — clear it by tightening the
"Keep on clean" list.

## Native execution (use your installed Claude Code / Codex)

Set `LOCAL_NATIVE_AGENTS=claude-code,codex` (a comma-separated **allow-list** of the
subscription harnesses to run natively) to run those agents as a **host process** driving
your OWN already-installed `claude` / `codex` CLI with its ambient login — no leased
credential. That's the only required setting: the harness server it spawns
(`node <entry>`) defaults to the `@cat-factory/executor-harness` package that ships as a
dependency of `@cat-factory/local-server`, so a fresh install works out of the box — just
like an unset `LOCAL_HARNESS_IMAGE` falls back to the pinned recommended image. Set
`LOCAL_HARNESS_ENTRY` only to override it with a custom or source-checkout build.

Only a step whose model maps to a **listed harness's NATIVE vendor** goes native: that is
Anthropic's own `claude` (for `claude-code`) and OpenAI's `codex`. A step pinned to a
non-native vendor that merely reuses the `claude-code` harness (GLM / Kimi / DeepSeek), or
to a proxy model, is **not** run natively — it still uses the sandboxed per-run container
path (so it leases its real credential / base URL instead of silently running on your own
Anthropic login). Those steps therefore still need `LOCAL_HARNESS_IMAGE`; if every step in
your pipelines is Claude/Codex you can run native-only with no image.

> ⚠️ **No sandbox.** The agent runs as a plain subprocess with your full shell + file
> access and your personal subscription (no spend metering, no model-locking). This is
> acceptable ONLY because it's your own machine — it is opt-in and off by default. The
> Tester's local docker-compose infra is unavailable in native mode for now (a follow-up
> adds host-Docker compose with per-run project names + git-worktree isolation).
