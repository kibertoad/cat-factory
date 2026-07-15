# cat-factory

Website: [www.catfactory.ai](http://www.catfactory.ai)

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
│  Vue Flow    │ ───── REST ─────────▶ │  (runtimes/cloudflare)    │
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

The domain + the HTTP layer are **runtime-neutral**, so the same backend serves two
deployment targets: the Cloudflare Worker above and a **Node.js service**
(`backend/runtimes/node`, Postgres via Drizzle + pg-boss for durable jobs). Each
facade supplies only its differentiators; a shared conformance suite runs the same
assertions against both to keep them from drifting.

## Repository layout

One pnpm workspace, split into reusable **libraries** (published to npm + a public
runner image on GHCR and Docker Hub) and example **deployments** that depend on them. Other
organizations copy `deploy/*`, point the config at their own resources, and
deploy both halves on their end.

**Libraries** (published):

| Path                                                                                   | Package                               | Role                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`frontend/app`](./frontend/app)                                                       | `@cat-factory/app`                    | Reusable **Nuxt layer** (`ssr: false`) — the board UI, Pinia stores, composables, the WebSocket stream. Consumed via `extends`.                                                                                                                               |
| [`backend/packages/contracts`](./backend/packages/contracts)                           | `@cat-factory/contracts`              | Valibot wire contracts shared by SPA + the backends.                                                                                                                                                                                                          |
| [`backend/packages/kernel`](./backend/packages/kernel)                                 | `@cat-factory/kernel`                 | Shared vocabulary: domain types, pure logic + constants, and **all** repository/port interfaces.                                                                                                                                                              |
| [`backend/packages/caching`](./backend/packages/caching)                               | `@cat-factory/caching`                | The app-level caching seam (layered-loader): `createAppCaches` builds the named in-memory read-through caches behind the kernel `AppCaches` port, with optional Redis-notified invalidation. See [its README](./backend/packages/caching/README.md).          |
| [`backend/packages/orchestration`](./backend/packages/orchestration)                   | `@cat-factory/orchestration`          | The delivery-workflow engine + domain **composition root** (`createCore()`): module services for execution, bootstrap, pipelines, board, requirements, merge, …                                                                                               |
| [`backend/packages/integrations`](./backend/packages/integrations)                     | `@cat-factory/integrations`           | Opt-in integration services (GitHub, documents, tasks, environments, runner pools) behind kernel ports.                                                                                                                                                       |
| [`backend/packages/agents`](./backend/packages/agents)                                 | `@cat-factory/agents`                 | Agent catalog + prompt composition (`systemPromptFor`/`userPromptFor`, the per-kind roles, prompt-version registry) **and the AI provisioning facade** (`CompositeModelProvider` + the neutral resolvers).                                                    |
| [`backend/packages/provider-bedrock`](./backend/packages/provider-bedrock)             | `@cat-factory/provider-bedrock`       | Opt-in AWS Bedrock model resolver (`@ai-sdk/amazon-bedrock`) with a supported-model allow-list; mixed into a facade's registry when configured. See [its README](./backend/packages/provider-bedrock/README.md).                                              |
| [`backend/packages/spend`](./backend/packages/spend)                                   | `@cat-factory/spend`                  | The spend safeguard: pricing tables + spend metering/gating.                                                                                                                                                                                                  |
| [`backend/packages/workspaces`](./backend/packages/workspaces)                         | `@cat-factory/workspaces`             | Workspace + account services.                                                                                                                                                                                                                                 |
| [`backend/packages/server`](./backend/packages/server)                                 | `@cat-factory/server`                 | Runtime-neutral **HTTP layer** shared by every facade: all Hono controllers, middleware (auth/authz/CORS/error), request helpers, the gateway seams, the `AppConfig` contract, and the shared row↔domain mappers.                                             |
| [`backend/packages/prompt-fragments`](./backend/packages/prompt-fragments)             | `@cat-factory/prompt-fragments`       | The built-in tier of best-practice prompt fragments. See [its README](./backend/packages/prompt-fragments/README.md).                                                                                                                                         |
| [`backend/packages/gates`](./backend/packages/gates)                                   | `@cat-factory/gates`                  | The built-in polling-gate suite (CI, merge-conflicts, post-release health + on-call escalation), authored through the public `registerGate` seam; a facade imports it and wires each gate's provider.                                                         |
| [`backend/packages/consensus`](./backend/packages/consensus)                           | `@cat-factory/consensus`              | Opt-in consensus orchestration (specialist panel / debate / ranked voting) that fans an agent step across runs and reconciles them, with task-estimate gating.                                                                                                |
| [`backend/packages/gitlab`](./backend/packages/gitlab)                                 | `@cat-factory/gitlab`                 | Opt-in GitLab VCS provider: the provider-neutral `VcsClient`/webhook/provisioning ports over GitLab REST v4, self-registered via `registerVcsProvider('gitlab')`.                                                                                             |
| [`backend/packages/provider-cloudflare`](./backend/packages/provider-cloudflare)       | `@cat-factory/provider-cloudflare`    | Opt-in Cloudflare Workers AI model registry mixed into a `CompositeModelProvider` (in-process binding on the Worker, OpenAI-compatible REST elsewhere).                                                                                                       |
| [`backend/packages/provider-s3`](./backend/packages/provider-s3)                       | `@cat-factory/provider-s3`            | Opt-in AWS S3 blob backend implementing the kernel `BinaryBlobBackend` port over an S3 bucket. See [its README](./backend/packages/provider-s3/README.md).                                                                                                    |
| [`backend/packages/eks`](./backend/packages/eks)                                       | `@cat-factory/eks`                    | Opt-in AWS **EKS** runner + environment backends: reuses the native Kubernetes transport/provider verbatim, adding only EKS IAM (SigV4 STS `GetCallerIdentity`) apiserver-token minting. See [its README](./backend/packages/eks/README.md).                  |
| [`backend/packages/observability-langfuse`](./backend/packages/observability-langfuse) | `@cat-factory/observability-langfuse` | Opt-in Langfuse trace sink: a fetch-based `LlmTraceSink` streaming LLM generations + tool spans; runs on both the Worker and Node facades. See [its README](./backend/packages/observability-langfuse/README.md).                                             |
| [`backend/packages/observability-otel`](./backend/packages/observability-otel)         | `@cat-factory/observability-otel`     | Opt-in OpenTelemetry (OTLP) trace + metrics publisher: a workerd-safe fetch exporter and the official `@opentelemetry/*` SDK exporter for Node, kept conformant by a shared mapping layer. See [its README](./backend/packages/observability-otel/README.md). |
| [`backend/packages/sandbox`](./backend/packages/sandbox)                               | `@cat-factory/sandbox`                | Parallel prompt/model testing surface: versioned prompt candidates, experiment matrices, judge + objective grading. Isolated so it can be extracted.                                                                                                          |
| [`backend/packages/sandbox-fixtures`](./backend/packages/sandbox-fixtures)             | `@cat-factory/sandbox-fixtures`       | Hand-authored, graded no-repo fixtures (inline requirements/clarity/code-review/architecture inputs + expectations) the sandbox grades against.                                                                                                               |
| [`backend/packages/cli`](./backend/packages/cli)                                       | `@cat-factory/cli`                    | Bootstrap CLI (`cat-factory init`): scaffolds a local-mode deployment on your machine — generates crypto secrets, mints a GitHub/GitLab PAT, writes gitignored `.env`. See [its README](./backend/packages/cli/README.md).                                    |

**AWS-stack packages** (opt-in) — three independent, capability-scoped AWS integrations, each
registering into its own seam and sharing no dependencies, so a deployment pulls in only what it
uses (and an all-AWS deployment composes all three):

- [`@cat-factory/provider-bedrock`](./backend/packages/provider-bedrock) — Bedrock **LLM models**
  (mixed into the `CompositeModelProvider`); see its
  [README](./backend/packages/provider-bedrock/README.md).
- [`@cat-factory/provider-s3`](./backend/packages/provider-s3) — S3 **blob storage** (the kernel
  `BinaryBlobBackend` port); see its [README](./backend/packages/provider-s3/README.md).
- [`@cat-factory/eks`](./backend/packages/eks) — EKS **runner + environment backends**; see its
  [README](./backend/packages/eks/README.md) for the design (AWS-SDK-free, WebCrypto SigV4 token
  minting) and the floci integration-test setup.

**Runtime facades** (one per deployment target; serve the same `@cat-factory/server` app):

| Path                                                           | Package                     | Role                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`backend/runtimes/cloudflare`](./backend/runtimes/cloudflare) | `@cat-factory/worker`       | Cloudflare Worker facade: D1 repos, Durable Objects, Workflows, per-run Containers, queues/cron, the CF gateway impls. Thin `createApp()`/`buildContainer()` over `@cat-factory/server`; ships the D1 `migrations/`. |
| [`backend/runtimes/node`](./backend/runtimes/node)             | `@cat-factory/node-server`  | Node.js service facade: serves the shared app via `@hono/node-server` with Drizzle/Postgres repos + pg-boss durable execution. `start()` / `createServer()`; `DATABASE_URL` selects the database.                    |
| [`backend/runtimes/local`](./backend/runtimes/local)           | `@cat-factory/local-server` | Local-mode facade: the Node stack with agent jobs run as local Docker/Podman containers and GitHub reached via a PAT, so a developer runs the whole product on their own machine. `startLocal()`.                    |

**Internal** (private; not published to npm):

| Path                                                                               | Package                             | Role                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`backend/internal/executor-harness`](./backend/internal/executor-harness)         | `@cat-factory/executor-harness`     | The payload that runs **inside** each per-run container (the Pi coding-agent harness). Published to **npm** (the entry local native mode spawns) **and** as a public multi-arch **Docker image to GHCR + Docker Hub**. See [its README](./backend/internal/executor-harness/README.md). |
| [`backend/internal/benchmark-harness`](./backend/internal/benchmark-harness)       | `@cat-factory/benchmark-harness`    | Headless agent benchmarking (`cat-bench`); internal. See [its README](./backend/internal/benchmark-harness/README.md).                                                                                                                                                                  |
| [`backend/internal/conformance`](./backend/internal/conformance)                   | `@cat-factory/conformance`          | Cross-runtime conformance suite + the canonical deterministic `FakeAgentExecutor`; run by both runtime facades' test suites to mandate feature parity.                                                                                                                                  |
| [`backend/internal/e2e`](./backend/internal/e2e)                                   | `@cat-factory/e2e`                  | Playwright end-to-end suite: a real Chromium drives the real SPA against a real Node backend (real Postgres + WebSocket push), only external deps faked. See [its README](./backend/internal/e2e/README.md).                                                                            |
| [`backend/internal/smoketest-harness`](./backend/internal/smoketest-harness)       | `@cat-factory/smoketest-harness`    | Headless Pi-agent smoketest (`cat-smoke`): runs real coding tasks through the actual Pi setup against Cloudflare AI and flags breakage / dead-ends / loops (no grading). See [its README](./backend/internal/smoketest-harness/README.md).                                              |
| [`backend/internal/deploy-harness`](./backend/internal/deploy-harness)             | `@cat-factory/deploy-harness`       | Container payload that renders a service's Kubernetes manifests (kubectl/kustomize/helm) into a per-PR namespace for ephemeral environments; carries no secrets. See [its README](./backend/internal/deploy-harness/README.md).                                                         |
| [`backend/internal/example-custom-agent`](./backend/internal/example-custom-agent) | `@cat-factory/example-custom-agent` | Worked example of a company-authored agent package registered purely via the public `registerAgentKind` + `registerPipeline` seams — a repo-writing agent that ships with zero harness changes.                                                                                         |

**Deployments** (examples; copy these to deploy on your own infra):

| Path                                   | Package                        | Role                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`deploy/backend`](./deploy/backend)   | `@cat-factory/deploy-backend`  | Cloudflare Worker deployment: re-exports `@cat-factory/worker` + the production `wrangler.toml`. See [its README](./deploy/backend/README.md).                                                     |
| [`deploy/node`](./deploy/node)         | `@cat-factory/deploy-node`     | Node.js service deployment: calls `@cat-factory/node-server`'s `start()` (Postgres + pg-boss); ships a `Dockerfile` + `.env.example`. See [its README](./deploy/node/README.md).                   |
| [`deploy/frontend`](./deploy/frontend) | `@cat-factory/deploy-frontend` | Pages deployment: a thin Nuxt app that `extends` `@cat-factory/app` + the Pages `wrangler.toml`. See [its README](./deploy/frontend/README.md).                                                    |
| [`deploy/local`](./deploy/local)       | `@cat-factory/deploy-local`    | Local-mode deployment: calls `@cat-factory/local-server`'s `startLocal()` — agent jobs as local Docker containers, GitHub via a PAT, a local Postgres. See [its README](./deploy/local/README.md). |

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
- **Model support** — per-block model selection, the Cloudflare → direct →
  subscription fallback ladder ("subscriptions always win"), the Pi / Claude Code /
  Codex harnesses, flat-rate quota vs the spend budget, and the individual-only
  (Claude-on-org) rule. [`docs/model-support.md`](./backend/docs/model-support.md).
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
  declarative manifest, or a hand-written native adapter.
  [`docs/environments-integration.md`](./backend/docs/environments-integration.md) ·
  [native adapters](./backend/docs/native-environment-adapter.md).
- **Prompt-fragment library** — tenant-scoped, repo-sourced guidelines selected
  per run. [ADR 0006](./backend/docs/adr/0006-prompt-fragment-library.md).
- **Self-hosted runner pool** — run coding jobs on your own infra.
  [Operator guide](./backend/docs/runner-pool-integration.md) ·
  [Kubernetes topology](./backend/docs/kubernetes-topology.md) ·
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
- [`docs/glossary.md`](./docs/glossary.md) — vocabulary + naming map (block vs task vs
  card, the dir↔package names, runner/executor/transport, and where gates / agent kinds /
  migration parity live).
- [`AGENTS.md`](./AGENTS.md) — orientation for coding agents; each `backend/packages/*` and
  `backend/runtimes/*` also carries its own `AGENTS.md` with a "where things live" map.

**Integrations & features**

- [Model support — selection, fallbacks, harnesses & provisioning](./backend/docs/model-support.md)
- [Authentication](./backend/docs/auth.md)
- [GitHub integration — design](./backend/docs/github-integration.md) ·
  [operations runbook](./backend/docs/github-operations.md) ·
  [App Manifest](./backend/docs/github-app-manifest.html)
- [Document sources](./backend/docs/document-sources.md)
- [Ephemeral environments](./backend/docs/environments-integration.md) ·
  [native adapters](./backend/docs/native-environment-adapter.md)
- [Self-hosted runner pool](./backend/docs/runner-pool-integration.md) ·
  [Kubernetes topology](./backend/docs/kubernetes-topology.md)

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
- [0007 — Service-owned provisioning (what/where ÷ how split)](./backend/docs/adr/0007-per-service-provisioning.md)
- [0008 — Local k3s guided setup](./backend/docs/adr/0008-local-k3s-guided-setup.md)
- [0009 — Mothership mode: persistence RPC, not direct frontend calls](./backend/docs/adr/0009-mothership-persistence-rpc.md)
- [0010 — Deferred from-scratch k3d cluster-create coverage](./backend/docs/adr/0010-defer-k3d-create-coverage.md)
- [0011 — Inline tester quality-control (QC) companion](./backend/docs/adr/0011-tester-quality-companion.md)
- [0012 — Docker Compose build-from-source support](./backend/docs/adr/0012-compose-build-from-source.md)
- [0013 — Initiatives: long-running multi-task work containers](./backend/docs/adr/0013-initiatives-feature.md)
- [0014 — Technological-migration initiative preset](./backend/docs/adr/0014-tech-migration-preset.md)
- [0015 — Deployer as the sole environment provisioner](./backend/docs/adr/0015-deployer-single-provisioner.md)
- [0016 — Initiative presets (registrable planning-shape extension)](./backend/docs/adr/0016-initiative-presets.md)
- [0017 — Documentation-type tasks as first-class authoring](./backend/docs/adr/0017-document-task-improvements.md)
- [0018 — App-owned AgentKindRegistry (no module-global registry)](./backend/docs/adr/0018-agent-kind-registry-di.md)
- [0019 — Frontend blocks, self-contained UI testing, dev previews](./backend/docs/adr/0019-frontend-preview-ui-testing.md)
- [0020 — Tiered spend budgets (account / workspace / user)](./backend/docs/adr/0020-tiered-spend-budgets.md)

## Deployment

The two halves are deployed from the example packages under `deploy/`. Each
carries its own config: the backend Worker in
[`deploy/backend/`](./deploy/backend/wrangler.toml) and the frontend Pages
project in [`deploy/frontend/`](./deploy/frontend/wrangler.toml). The backend can
**alternatively** run as a long-running Node.js service (Postgres + pg-boss) from
[`deploy/node/`](./deploy/node) — same HTTP API, different runtime. To deploy on
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
container image is published independently to GHCR + Docker Hub (see
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

### Backend (Node.js service — alternative to the Worker)

Instead of the Worker, run the same backend as a long-running Node.js service over
**Postgres** (durable jobs on **pg-boss**). It needs only `DATABASE_URL` (the schema
migrates on boot); all other config is environment-driven and documented in
[`deploy/node/.env.example`](./deploy/node/.env.example).

```sh
cd deploy/node
cp .env.example .env          # set DATABASE_URL, auth, model keys, …
pnpm start                    # builds @cat-factory/node-server, then runs the service

# or as a container (build from the repo root):
docker build -f deploy/node/Dockerfile -t cat-factory-node .
docker run --rm -p 8787:8787 --env-file deploy/node/.env cat-factory-node
```

Requires **Node 24 or 26** (the entry runs via built-in type stripping; the scripts
load `.env` with Node's native `--env-file`). See
[`deploy/node/README.md`](./deploy/node/README.md).

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
