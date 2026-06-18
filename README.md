# cat-factory

**A self-hosted platform for designing software on a visual board and having LLM
agents build it — turning architecture blocks into real, reviewed pull
requests, with the whole pipeline observable in real time.**

You sketch a system as a board of **services → modules → tasks**, attach
requirements (PRDs, RFCs, tracker issues), and run **agent pipelines** against
each block. Coding agents clone the linked repo, implement the work, open a PR,
and push live progress back to the board. Reviewer, tester and acceptance agents
sharpen the result; humans stay in the loop through decision prompts, PR review
and a hard spend cap.

## Table of contents

- [What it is](#what-it-is)
- [What it supports](#what-it-supports)
- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Feature guide](#feature-guide)
- [Documentation index](#documentation-index)
- [Deployment](#deployment)

## What it is

cat-factory is a **software-development agent management platform**. It is
**self-hosted** and runs end-to-end on Cloudflare: a Nuxt single-page app talks
to a Cloudflare Worker (Hono + D1), and the heavy coding work runs in per-run
Cloudflare Containers (or your own runner pool). It pairs a spatial planning
surface (a Vue Flow canvas) with a durable, server-side execution engine so runs
make progress whether or not a browser is open.

Two ideas anchor the model:

- **The board is the plan.** A "service" is a `Block` with `level: 'frame'`;
  modules are sub-frames, tasks are leaves. Dependencies are edges. The board is
  both the design artifact and the unit of work agents act on.
- **Agents do real work through pull requests.** The implementation phases run a
  coding agent on an actual checkout; "done" means a PR exists and its CI is
  green, not merely that text was generated.

## What it supports

| Capability                        | What you get                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visual architecture boards**    | A pannable/zoomable canvas of frames (services), modules and tasks with dependency edges, drag-drop reparenting, and semantic level-of-detail.                             |
| **Accounts & workspaces**         | A signed-in user switches between a personal account and any **orgs** they belong to; an account owns many **workspaces** (boards). Visibility is by membership.           |
| **Agent pipelines**               | Reusable, ordered chains of agent steps (architect → coder → blueprints → reviewer → tester → acceptance, plus mocker/playwright/deployer/custom kinds) applied per block. |
| **Durable, observable execution** | Runs are driven by Cloudflare Workflows and stream live step/subtask progress, decision prompts, and failures to the board over WebSockets.                                |
| **Real code changes via PRs**     | Coding agents (`coder`, `mocker`, `playwright`) run in a per-run container, clone the repo, implement, and open a PR; merge flips the block to done.                       |
| **Requirements review**           | A stateless reviewer agent raises gaps/clarifications/assumptions/risks on a block; a human answers each, then the agent folds the answers back into the description.      |
| **Service blueprints**            | A Blueprinter agent decomposes a repo into a `service → modules → features` map stored **in the repo** (`blueprints/`) and reconciles it onto the board.                   |
| **Repo bootstrap**                | Adapt a reference architecture (or scaffold from scratch) into a pre-created empty repo and force-push the result, materialising a new service frame on the board.         |
| **On-demand board scan**          | Decompose an existing repo into a board structure / reusable blueprint anchored to file references.                                                                        |
| **GitHub integration**            | Connect an account to GitHub via a GitHub App for repo/PR/issue read & write plus webhooks, with local D1 projections kept fresh.                                          |
| **Document & task sources**       | Link Confluence/Notion docs and Jira/Linear/GitHub issues to a board: import, expand into structure, or attach as agent context.                                           |
| **Ephemeral environments**        | Register your own preview-environment tooling via a declarative HTTP manifest so `deployer`/`tester` agents provision and run against it.                                  |
| **Prompt-fragment library**       | A tenant-scoped, versioned catalog of best-practice guidelines (built-in ∪ account ∪ workspace), optionally sourced from a repo, selected per run.                         |
| **Bring-your-own runner pool**    | Route coding jobs to your own Kubernetes/Nomad/scheduler pool instead of Cloudflare Containers, described by a manifest.                                                   |
| **Spend safeguards**              | Every LLM call is metered into an org-wide monthly budget; runs **pause** at the cap and resume when the period rolls over (or on an explicit override).                   |
| **Model picker**                  | Per-block model selection; each model runs on Cloudflare Workers AI by default and upgrades to its direct provider API when a key is set.                                  |
| **Benchmarking**                  | A headless harness (`cat-bench`) that scores agents (requirement review / code review / implementation) across models and prompt versions.                                 |

## How it works

```
┌──────────────┐   WebSocket events    ┌───────────────────────────┐
│  Nuxt SPA    │ ◀──── push, not ────  │  Cloudflare Worker        │
│ (frontend/app)│      polling         │  Hono controllers + D1    │
│  Vue Flow    │ ───── REST ─────────▶ │  (backend/packages/worker)│
└──────────────┘                       └────────────┬──────────────┘
                                                     │ ports (DI)
                                          ┌──────────▼──────────┐
                                          │   domain packages   │
                                          │  kernel + services  │
                                          └──────────┬──────────┘
                                                     │ dispatch coding jobs
                              ┌──────────────────────▼───────────────────────┐
                              │ per-run Cloudflare Container (or runner pool) │
                              │ executor-harness → Pi coding agent → PR    │
                              └───────────────────────────────────────────────┘
```

The canonical pattern is **async + durable + observable**: a service starts a run,
a Cloudflare **Workflows** instance drives it one checkpointed step at a time, a
container executes the long-running agent work asynchronously, and every
persisted transition is **pushed** to the browser through a per-workspace Durable
Object. The same shape is reused by execution, bootstrap and blueprints. The
end-to-end flows are written up in [`CLAUDE.md`](./CLAUDE.md).

## Repository layout

One pnpm workspace, split into reusable **libraries** (published to npm + a GHCR
runner image) and example **deployments** that depend on them. Other
organizations copy `deploy/*`, point the config at their own resources, and
deploy both halves on their end.

**Libraries** (published):

| Path                                                                       | Package                         | Role                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`frontend/app`](./frontend/app)                                           | `@cat-factory/app`              | Reusable **Nuxt layer** (`ssr: false`) — the board UI, Pinia stores, composables, the WebSocket stream. Consumed via `extends`.                                                                               |
| [`backend/packages/contracts`](./backend/packages/contracts)               | `@cat-factory/contracts`        | Valibot wire contracts shared by SPA + Worker.                                                                                                                                                                |
| [`backend/packages/kernel`](./backend/packages/kernel)                     | `@cat-factory/kernel`           | Shared vocabulary: domain types, pure logic + constants, and **all** repository/port interfaces.                                                                                                              |
| [`backend/packages/orchestration`](./backend/packages/orchestration)       | `@cat-factory/orchestration`    | The delivery-workflow engine + domain **composition root** (`createCore()`): module services for execution, bootstrap, pipelines, board, requirements, merge, …                                               |
| [`backend/packages/integrations`](./backend/packages/integrations)         | `@cat-factory/integrations`     | Opt-in integration services (GitHub, documents, tasks, environments, runner pools) behind kernel ports.                                                                                                       |
| [`backend/packages/agents`](./backend/packages/agents)                     | `@cat-factory/agents`           | Agent catalog + prompt composition (`systemPromptFor`/`userPromptFor`, the per-kind roles, prompt-version registry).                                                                                          |
| [`backend/packages/spend`](./backend/packages/spend)                       | `@cat-factory/spend`            | The spend safeguard: pricing tables + spend metering/gating.                                                                                                                                                   |
| [`backend/packages/workspaces`](./backend/packages/workspaces)             | `@cat-factory/workspaces`       | Workspace + account services.                                                                                                                                                                                 |
| [`backend/packages/worker`](./backend/packages/worker)                     | `@cat-factory/worker`           | Reusable Cloudflare Worker **library**: Hono controllers, D1 repos, Durable Objects, Workflows, the DI composition root. Exposes `createApp()` + the handler/DO/Workflow exports; ships the D1 `migrations/`. |
| [`backend/packages/prompt-fragments`](./backend/packages/prompt-fragments) | `@cat-factory/prompt-fragments` | The built-in tier of best-practice prompt fragments. See [its README](./backend/packages/prompt-fragments/README.md).                                                                                         |

**Internal** (private; not published to npm):

| Path                                                                         | Package                          | Role                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`backend/internal/executor-harness`](./backend/internal/executor-harness)   | `@cat-factory/executor-harness`  | The payload that runs **inside** each per-run container (the Pi coding-agent harness). Published as a **Docker image to GHCR** (not npm). See [its README](./backend/internal/executor-harness/README.md). |
| [`backend/internal/benchmark-harness`](./backend/internal/benchmark-harness) | `@cat-factory/benchmark-harness` | Headless agent benchmarking (`cat-bench`); internal. See [its README](./backend/internal/benchmark-harness/README.md).                                                                                     |

**Deployments** (examples; copy these to deploy on your own infra):

| Path                                   | Package                        | Role                                                                                                                                            |
| -------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`deploy/backend`](./deploy/backend)   | `@cat-factory/deploy-backend`  | Worker deployment: re-exports `@cat-factory/worker` + the production `wrangler.toml`. See [its README](./deploy/backend/README.md).             |
| [`deploy/frontend`](./deploy/frontend) | `@cat-factory/deploy-frontend` | Pages deployment: a thin Nuxt app that `extends` `@cat-factory/app` + the Pages `wrangler.toml`. See [its README](./deploy/frontend/README.md). |

In this repo the deployments depend on the libraries via `workspace:*`; in your
own copy you swap that for the published npm version. The backend is a hexagonal
monorepo — controllers (worker) → services (core) → ports, with infra adapters
wired in `container.ts`. The full breakdown is in the
[backend overview](./backend/README.md). Releases use changesets — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Feature guide

Each capability has a deeper write-up; start here and follow the link.

- **Boards, services & repo linkage** — the `frame → module → task` model, how a
  repo is resolved for a block at runtime, and drag-drop reparenting.
  [`CLAUDE.md` → Board / service / repo-linkage model](./CLAUDE.md).
- **Execution & real-time events** — the durable run engine, decision prompts,
  failure/retry surface, and the push-not-poll event hub.
  [Backend → Execution & real-time events](./backend/README.md).
- **Requirements review** — the stateless, synchronous reviewer agent.
  [`CLAUDE.md` → Requirements review flow](./CLAUDE.md).
- **Service blueprints** — the in-repo `blueprints/` map and board reconciliation.
  [`CLAUDE.md` → Service blueprints flow](./CLAUDE.md).
- **Repo bootstrap** — create a repo from a reference architecture.
  [`CLAUDE.md` → Repo bootstrap flow](./CLAUDE.md).
- **Authentication** — "Login with GitHub"; GitHub accounts are the identity
  provider, so there's no separate user store.
  [`docs/auth.md`](./backend/docs/auth.md).
- **GitHub integration** — connect an account via a GitHub App for repo/PR/issue
  read & write plus webhooks; the installation is shared across the account's
  workspaces, and each workspace explicitly links the repos it tracks.
  [Design](./backend/docs/github-integration.md) ·
  [Operations runbook](./backend/docs/github-operations.md) ·
  [Two-app provisioning (ADR 0005)](./backend/docs/adr/0005-two-app-repo-provisioning.md).
- **Document sources** — link requirements, RFCs and PRDs from Confluence/Notion
  and expand them into structure. [`docs/document-sources.md`](./backend/docs/document-sources.md).
- **Ephemeral environments** — plug in your own preview-environment tooling via a
  declarative manifest. [`docs/environments-integration.md`](./backend/docs/environments-integration.md).
- **Prompt-fragment library** — tenant-scoped, repo-sourced guidelines selected
  per run. [ADR 0006](./backend/docs/adr/0006-prompt-fragment-library.md).
- **Self-hosted runner pool** — run coding jobs on your own infra.
  [Operator guide](./backend/docs/runner-pool-integration.md) ·
  [ADR 0004](./backend/docs/adr/0004-self-hosted-runner-pool.md).
- **Storage & retention** — the D1 data model's retention sweeps.
  [`docs/storage-and-retention.md`](./backend/docs/storage-and-retention.md).
- **Container reaping** — how per-run containers get reclaimed, and the current
  gaps. [`docs/container-reaping.md`](./backend/docs/container-reaping.md).
- **Benchmarking** — score agents across models and prompt versions.
  [`benchmark-harness` README](./backend/internal/benchmark-harness/README.md).

## Documentation index

**Start here**

- [Backend overview](./backend/README.md) — the Worker + D1 monorepo and its layering.
- [`frontend/app/README.md`](./frontend/app/README.md) — the Nuxt SPA layer.
- [`CLAUDE.md`](./CLAUDE.md) — the cross-cutting runtime flows (execution + events,
  bootstrap, blueprints, requirements review, the board/repo-linkage model) in one
  place for quick lookup.

**Integrations & features**

- [Authentication](./backend/docs/auth.md)
- [GitHub integration — design](./backend/docs/github-integration.md) ·
  [operations runbook](./backend/docs/github-operations.md) ·
  [App Manifest](./backend/docs/github-app-manifest.html)
- [Document sources](./backend/docs/document-sources.md)
- [Ephemeral environments](./backend/docs/environments-integration.md)
- [Self-hosted runner pool](./backend/docs/runner-pool-integration.md)

**Operations**

- [Storage & retention](./backend/docs/storage-and-retention.md)
- [Container reaping & deletion](./backend/docs/container-reaping.md)

**Architecture decisions (ADRs)**

- [0001 — GitHub integration via a GitHub App](./backend/docs/adr/0001-github-app-integration.md)
- [0002 — Cloudflare as the runtime platform](./backend/docs/adr/0002-cloudflare-platform.md)
- [0003 — Pluggable ephemeral-environment providers](./backend/docs/adr/0003-ephemeral-environment-provider.md)
- [0004 — Self-hosted runner pool](./backend/docs/adr/0004-self-hosted-runner-pool.md)
- [0005 — Two-app tiering for repository creation](./backend/docs/adr/0005-two-app-repo-provisioning.md)
- [0006 — Tenant-scoped prompt-fragment library](./backend/docs/adr/0006-prompt-fragment-library.md)

## Deployment

The two halves are deployed from the example packages under `deploy/`. Each
carries its own `wrangler.toml`: the backend Worker in
[`deploy/backend/`](./deploy/backend/wrangler.toml) and the frontend Pages
project in [`deploy/frontend/`](./deploy/frontend/wrangler.toml). To deploy on
**your own** infrastructure, copy those directories and swap the `workspace:*`
dependency for the published npm version — see each package's README. The
reference deployment below runs on Cloudflare under the `iselwin@gmail.com`
account (`wrangler whoami` must show `fe0047c6e869c8cb875ca425a9c341af`).

| Piece    | Cloudflare resource          | Production URL                        |
| -------- | ---------------------------- | ------------------------------------- |
| Backend  | Worker `cat-factory-backend` | `https://catfactory-api.kiberion.com` |
| Frontend | Pages project `cat-factory`  | `https://catfactory.kiberion.com`     |
| Data     | D1 database `cat_factory`    | (bound to the Worker as `DB`)         |

**Deploy the backend first** so any schema the new frontend expects is already
live, then the frontend. Migrations run **before** the Worker deploy. The runner
container image is published independently to GHCR (see
[`backend/internal/executor-harness`](./backend/internal/executor-harness/README.md)
and `.github/workflows/docker-publish.yml`); the backend `wrangler.toml`
references it by tag.

### Backend (Worker + D1)

```sh
cd deploy/backend

# 1. apply any new migrations to the PRODUCTION D1 (review the pending list first)
wrangler d1 migrations list  cat_factory --remote
wrangler d1 migrations apply cat_factory --remote     # == pnpm db:migrate:remote

# 2. deploy the Worker (also rolls the container image, workflows, cron triggers).
#    `pnpm deploy` builds @cat-factory/worker first, then `wrangler deploy`.
pnpm deploy
```

The migrations ship with the `@cat-factory/worker` library, so `migrations_dir`
points at `node_modules/@cat-factory/worker/migrations` (see the comment in
`deploy/backend/wrangler.toml` if your tooling can't follow the symlink). The
Worker prints its `*.workers.dev` URL; production traffic reaches it through the
`catfactory-api.kiberion.com` custom domain (configured in the Cloudflare
dashboard, not in `wrangler.toml`). First-time setup (auth, provider, GitHub-App
and container secrets) is in [`backend/README.md`](./backend/README.md#deploying)
— **auth is required or the API fails closed.**

### Frontend (Nuxt SPA → Pages)

The SPA is `ssr: false`, so the backend URL is **baked in at build time** from
`NUXT_PUBLIC_API_BASE` — it is _not_ a Pages runtime var. Build with the prod
API base, then deploy the static output:

```sh
cd deploy/frontend
NUXT_PUBLIC_API_BASE=https://catfactory-api.kiberion.com pnpm generate
pnpm deploy                            # wrangler pages deploy; project + dir from wrangler.toml
```

PowerShell equivalent for the build step:

```powershell
$env:NUXT_PUBLIC_API_BASE = "https://catfactory-api.kiberion.com"; pnpm generate
```

`pnpm generate` writes the static site to `.output/public`; `wrangler pages
deploy` (no args) reads the project name `cat-factory` and that output dir from
`deploy/frontend/wrangler.toml`. `main` is the Pages **production** branch, so the
deploy updates the `catfactory.kiberion.com` alias. Sanity-check after deploying:

```sh
curl -s https://catfactory-api.kiberion.com/health        # {"status":"ok"}
curl -s https://catfactory.kiberion.com | grep -o catfactory-api.kiberion.com   # baked API base
```

### Emergency takedown

[`backend/scripts/teardown-production.sh`](./backend/scripts/teardown-production.sh)
deletes the Worker (and its containers/workflows/crons), optionally the Pages
project (`--include-pages`), and **always preserves** the D1 data.
Re-deploying brings production back.
