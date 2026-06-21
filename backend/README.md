# Agent Architecture Board — Backend

Backend for the [`cat-factory`](../README.md) frontend. Split into a
**framework-agnostic core** and a **Cloudflare Worker facade**, as separate
packages, following the infrastructure/domain layering and module grouping of
`node-service-template`.

The Worker exposes one HTTP + WebSocket API over a Cloudflare **D1** database;
core holds all domain logic behind ports; long-running coding work runs in
per-run Cloudflare **Containers** (or a self-hosted runner pool). Most
integrations are **opt-in** — they assemble only when their config is present, so
a minimal deployment is just boards + pipelines.

> For the end-to-end runtime flows (execution + events, bootstrap, blueprints,
> requirements review, the board/repo-linkage model) read
> [`../CLAUDE.md`](../CLAUDE.md). This README is the package-level map.

## Table of contents

- [Packages](#packages) · [Layering](#layering-per-the-templates-architecture-doc)
- [Domain modules](#domain-modules) — what each core module does
- [Agents](#agents-vercel-ai-sdk) — the executors and the engine
- [Execution & real-time events](#execution--real-time-events)
- [Spend safeguards](#spend-safeguards)
- [Accounts & tenancy](#accounts--tenancy)
- [GitHub integration](#github-integration-optional)
- [Document & task sources](#document--task-sources-optional)
- [Requirements review](#requirements-review)
- [Service blueprints](#service-blueprints)
- [Ephemeral environments](#ephemeral-environments--the-deployer-agent-optional)
- [On-demand board scan](#on-demand-board-scan-repository--blueprint)
- [Prompt-fragment library](#prompt-fragment-library-optional)
- [Self-hosted runner pool](#self-hosted-runner-pool-optional)
- [Persistence & migrations](#persistence--migrations)
- [HTTP API](#http-api-selected)
- [Develop & test](#develop--test)
- [Deployment](#deploying)

## Packages

| Package                                                                                             | Role                                                                                                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@cat-factory/contracts`                                                                            | Valibot wire contract (entities + request bodies). Shared by the frontend and the backend.                      |
| `@cat-factory/kernel`                                                                               | Shared vocabulary: domain types, pure logic + constants, and **all** repository/port interfaces.                |
| `@cat-factory/orchestration`                                                                        | Domain layer: module services + the composition root (`createCore()`). No framework, no Cloudflare, no LLM SDK. |
| `@cat-factory/integrations`, `@cat-factory/agents`, `@cat-factory/spend`, `@cat-factory/workspaces` | The rest of the framework-agnostic domain, split by concern (integrations, agent prompts, spend, workspaces).   |
| `@cat-factory/worker`                                                                               | Infrastructure + API layer: Hono controllers, D1 repositories, composition root, the Worker.                    |

### Layering (per the template's architecture doc)

- **API layer** — `worker/src/modules/*/?*Controller.ts` (Hono routes), grouped by module.
- **Domain layer** — `orchestration/src/modules/*` services (+ the other domain packages) and
  `kernel/src/domain` models/logic. `kernel/src/ports` defines the repository **ports**; the
  domain depends on no concrete adapter.
- **Infrastructure layer** — `worker/src/infrastructure/*`: D1 repositories implementing the
  ports, the AI model provider, runtime adapters, config, and the DI composition root
  (`container.ts`). Services use constructor injection of a single `dependencies` object.

## Domain modules

The domain lives in `core/src/modules/*` — each is a small service (or cluster of
services) over ports, assembled in `core/src/container.ts`. The Worker mounts a
matching controller per module in `worker/src/modules/*`.

| Module                                        | Responsibility                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspaces`                                  | Board (workspace) lifecycle; assembles the full snapshot (blocks, pipelines, executions, spend) the SPA hydrates from.                     |
| `accounts`                                    | Tenancy: personal/org accounts, GitHub-membership-based visibility, the account ↔ workspace ownership graph.                               |
| `board`                                       | Block mutations — frames/modules/tasks CRUD, reparenting, dependency edges.                                                                |
| `pipelines`                                   | Saved, reusable agent-kind sequences (the pipeline palette).                                                                               |
| `agents`                                      | Agent-kind catalog, role/phase prompts, and the inline `AiAgentExecutor`.                                                                  |
| `execution`                                   | The run state machine: `advanceInstance` moves a run one step, handles decisions, failures/retries, context injection, and the spend gate. |
| `spend`                                       | Token metering + org-wide monthly budget enforcement.                                                                                      |
| `bootstrap`                                   | Reference architectures + the async repo-bootstrap task.                                                                                   |
| `boardScan`                                   | "Scan repository" → a `service → modules → features` blueprint, optionally spawned onto the board.                                         |
| `blueprints` _(in `agents`/`boardScan` flow)_ | The Blueprinter step that writes the in-repo `blueprints/` map and reconciles the board.                                                   |
| `requirements`                                | Stateless reviewer agent over a block's collected requirements.                                                                            |
| `github`                                      | GitHub App installs, repo/PR/issue projections, webhooks, repo provisioning (two-app tiering).                                             |
| `documents`                                   | Connect Confluence/Notion sources, import pages, plan board structure, link docs to blocks.                                                |
| `tasks`                                       | Connect Jira/Linear/issue trackers, import issues, link them to blocks as context.                                                         |
| `environments`                                | Provision/teardown ephemeral environments from a per-workspace provider manifest.                                                          |
| `fragmentLibrary`                             | Tenant-scoped prompt-fragment catalog + repo-linked sources + per-run relevance selection.                                                 |
| `runners`                                     | Bind a workspace to a self-hosted runner pool (manifest + encrypted secrets).                                                              |

The repository **ports** these depend on live in `core/src/ports/*`
(`agent-executor`, `model-provider`, `*-repositories`, `github-client`,
`document-source`, `environment-provider`, `runner-pool-provider`,
`fragment-selector`, `secret-cipher`, `token-usage`, `runtime`, …); their D1 /
HTTP / Cloudflare adapters live under `worker/src/infrastructure/*` and are
wired in `worker/src/infrastructure/container.ts`.

## Agents (Vercel AI SDK)

Each pipeline step is performed by an `AgentExecutor` (a port). Implementations:

- **`AiAgentExecutor`** (core) — real work through the Vercel AI SDK (`generateText`). The model
  is chosen per agent kind via `AgentRouting` ("which LLM, with what config, for what"),
  configured from Worker env vars (`AGENT_DEFAULT_PROVIDER/MODEL`, `AGENT_MODELS` JSON overrides).
  Concrete models are resolved by `CloudflareModelProvider` (Workers AI / OpenAI / Anthropic, plus
  the direct DashScope / DeepSeek / Moonshot providers). A block may also pick a specific model
  (`Block.modelId`) from the catalog in `kernel/src/domain/models.ts`; each model runs on Cloudflare
  Workers AI by default and switches to its direct provider API when that key is configured.
- **`ContainerAgentExecutor`** (worker) — runs the repo-operating steps (`coder`, `mocker`,
  `playwright`) in a per-run Cloudflare Container (the Pi coding-agent harness) that clones the
  repo, implements the block and opens a PR. Always composed with the inline executor by
  `CompositeAgentExecutor`; its prerequisites are mandatory and the Worker fails to start
  without them (there is no opt-out flag — container implementation is always on).
- **`FakeAgentExecutor`** (worker tests) — deterministic; used by the integration tests.

The engine itself (`ExecutionService`) is deterministic: `advanceInstance` moves one run forward
by exactly one agent-performed step. In production the durable Cloudflare Workflows driver calls
it in a loop (see "Execution & real-time events" below); the integration tests call it directly.

## Execution & real-time events

Runs are driven **durably and server-side**: starting a pipeline creates one Cloudflare Workflows
instance per run (`ExecutionWorkflow`, addressed by execution id), which loops calling
`advanceInstance` — one retriable, checkpointed step at a time — and parks on `waitForEvent` while
a human decision is outstanding. Progress no longer depends on a browser being open. A cron
"sweeper" re-drives any run whose Workflows instance died (eviction, a missed event).

Progress reaches the browser by **push, not polling**: each persisted transition is published to a
per-workspace `WorkspaceEventsHub` Durable Object (one instance per workspace, hibernatable
WebSockets), which fans the event out to subscribed clients. The SPA opens one WebSocket to
`GET /workspaces/:ws/events?token=<session>` (a browser can't set `Authorization` on a handshake,
so the token rides the query string, verified with the same HMAC signer as the REST gate) and
patches its stores from the events, refreshing on (re)connect to reconcile anything missed. When
the `WORKSPACE_EVENTS` binding is absent the engine simply pushes nothing.

## Spend safeguards

Every LLM call's token usage (input + output) is metered into a `token_usage` ledger (D1) by
the `SpendService`. Each call is priced into a single currency via a configurable price table
and summed over the current calendar month — the budget is **org-wide**, across all workspaces.
Before each agent step the engine checks `SpendService.isOverBudget()`; when the month's spend
reaches the limit it **pauses** the run (execution status `paused`) instead of incurring more
cost. The current status (`tokens`, `costSpent`, `costLimit`, `exceeded`) is attached to every
workspace snapshot, and the frontend shows a large warning and a "Resume anyway" action
(`POST /workspaces/:ws/spend/resume`) when the budget is exceeded. Paused runs also resume
automatically once the period rolls over.

Configured entirely through Worker vars (see `wrangler.toml`): `SPEND_MONTHLY_LIMIT`
(default ~100), `SPEND_CURRENCY` (default `EUR`), and `SPEND_MODEL_PRICES` (JSON per-model price
overrides per 1M tokens). The container executor reports no usage directly (its LLM proxy meters
tokens itself, to avoid double-counting), and test fakes report none.

## Accounts & tenancy

A signed-in user (authenticated by **"Login with GitHub"**, see
[`docs/auth.md`](./docs/auth.md)) acts within an **account**: their personal
account, plus any GitHub **orgs** they belong to. An account **owns many
workspaces** (boards), so a team shares the org's boards while keeping personal
ones separate. Visibility is by GitHub membership — switching the active account
re-scopes the board list. Account-bound things (the GitHub installation, the
account tier of the prompt-fragment library) are inherited by every workspace
under that account; a workspace can refine them. Schema in migration
`0017_accounts.sql`; the `accounts` core module + `AccountController` enforce the
`isMember` gate.

## GitHub integration (optional)

Connects each workspace to a GitHub org/account via a **GitHub App** so agents and
blocks can read and write real repos, with local D1 **projections** (repos/branches,
PRs/issues, commits/checks) kept fresh by **webhooks**, an on-demand resync endpoint,
and the cron reconciliation pass. It is **opt-in** (default-off, like the agents):
the core `github` module and worker adapters are wired only when a GitHub App is
configured. See [`docs/github-integration.md`](./docs/github-integration.md),
[`docs/github-operations.md`](./docs/github-operations.md), and
[`docs/adr/0001-github-app-integration.md`](./docs/adr/0001-github-app-integration.md).

Auth uses Web Crypto (`crypto.subtle`) — a thin `fetch` `GitHubClient`, no Octokit:
an RS256 app JWT mints short-lived installation tokens (cached in D1), and webhook
deliveries are HMAC-verified over the raw body before a fast `202` ack. New schema is
in migration `0004_github_projections.sql`. Configure via `GITHUB_APP_ID/SLUG` vars
and `GITHUB_APP_PRIVATE_KEY` (PKCS#8) + `GITHUB_WEBHOOK_SECRET` secrets.

**Creating new repos (two-app tiering).** Creating a repo programmatically needs
the App to hold `Administration: write`, which we don't want on every install. So
there are **two App registrations**: a default _restricted_ App (most installs)
and an opt-in _privileged_ App that carries `Administration: write`. An org opts
in by installing the privileged App; `GitHubAppRegistry` routes every token mint
by the installation's owning `appId`, and `GitHubConnection.canCreateRepos`
drives whether the bootstrap modal creates the repo directly or delegates to
GitHub's new-repo page. See
[ADR 0005](./docs/adr/0005-two-app-repo-provisioning.md) (`GITHUB_PRIVILEGED_APP_ID`

- `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`).

## Document & task sources (optional)

Link external **requirement** sources to a board and either expand them into
board structure or attach them to a block as context the agents read at run time.
Both integrations are **source-agnostic** (one provider port per source kind) and
**opt-in**, with per-workspace credentials stored **encrypted** in D1 (no source
secrets in `wrangler.toml`).

- **Document sources** (`documents` module, migration `0012_document_sources.sql`)
  — import a page, **plan** it into `services → modules → tasks` (LLM or a
  deterministic heading parser), **spawn** that structure onto the board, or link
  it to a task. Ships Confluence Cloud + Notion providers. See
  [`docs/document-sources.md`](./docs/document-sources.md).
- **Task sources** (`tasks` module, migration `0014_task_sources.sql`) — connect
  an issue tracker (Jira / Linear / GitHub Issues), import issues, and link them
  to blocks so agents see the tracker context during execution.

## Requirements review

A **stateless, synchronous** reviewer agent (`requirements` module,
`RequirementReviewService`, migration `0021_requirement_reviews.sql`) inspects a
block's _collected requirements_ — its description plus any linked PRD/RFC docs
and tracker issues — and raises a list of review items
(gaps / clarifications / assumptions / risks / questions), each with a
category/severity. A human replies to or dismisses each; once all are settled,
`incorporate()` rewrites the block description. Unlike execution/bootstrap this
flow uses **no container and no durable driver** — it calls the `ModelProvider`
port inline (like the document planner) and returns the updated entity, which the
SPA patches directly. One live review per block; the model resolves exactly like
an agent step (a block's pinned model wins, else the routing default, falling back
to Workers AI). Full flow in [`../CLAUDE.md`](../CLAUDE.md).

## Service blueprints

A **Blueprinter** agent (`agentKind: 'blueprints'`, run as a normal pipeline step)
decomposes a repo into the canonical `service → modules → features` tree and
persists it **in the repo** under `blueprints/` (`blueprint.json`, `overview.md`,
`modules/<slug>.md`, `version.json`), then reconciles the board's service frame
from it (match by name, add missing, refresh descriptions, **never delete**). It
reuses the whole execution engine, runs on the prior `coder` step's PR branch when
present (else the repo default branch), and is also kicked off after a successful
bootstrap to seed the initial map. Full flow in [`../CLAUDE.md`](../CLAUDE.md).

## Ephemeral environments + the Deployer agent (optional)

Lets a workspace plug in its **own** self-rolled ephemeral/preview-environment
tooling so a `deployer` agent can provision an environment and a `tester` agent can
run against it. It is **API-only and declarative**: an org registers a
Valibot-validated **manifest** describing its management API as HTTP request
templates for provision/status/teardown, an auth scheme (none / api-key / bearer /
basic / OAuth2 client-credentials / custom headers), and a dot-path mapping from its
arbitrary response onto a canonical environment handle. A single generic
`HttpEnvironmentProvider` interprets any manifest — no presets, no per-org code.

The `deployer` step is executed **deterministically by the engine** (it calls the
provider directly — no LLM, no token spend); the resulting handle is persisted in a
registry keyed by block and injected into downstream steps' `AgentRunContext`, so a
`tester` step discovers the live URL and how to authenticate. Like GitHub/Confluence
it is **opt-in** (the core `environments` module and worker adapters wire only when
configured).

Per-tenant provider credentials are supplied at registration and stored **encrypted
at rest** in D1 (AES-256-GCM via `SecretCipher`, per-record salt + IV, HKDF-derived
key); the manifest references them by logical key only. The single env secret is the
service-level master key. Configure via `ENVIRONMENTS_ENABLED=true` and the
`ENVIRONMENTS_ENCRYPTION_KEY` secret (required when enabled). New schema is in
migration `0008_environments.sql`. See
[`docs/environments-integration.md`](./docs/environments-integration.md) and
[`docs/adr/0003-ephemeral-environment-provider.md`](./docs/adr/0003-ephemeral-environment-provider.md).

## On-demand board scan (repository → blueprint)

A workspace-scoped **"scan repository"** command that decomposes an existing
codebase into one canonical board structure — a single **service**, the **modules**
inside it, and the **features** within each module — with every node anchored to the
code by explicit file/directory **references**. The result is persisted as a reusable
**repository blueprint**: a durable, LLM-friendly map kept per workspace (one per
`owner/name`, replaced in place on re-scan) that future work is scoped against and
re-run to keep current. A scan can also **spawn** the blueprint onto the board as a
frame/modules/tasks, folding each node's references into the block descriptions under
a parseable `Code references:` marker.

The shape mirrors the board's `frame → module → task` levels exactly, so a blueprint
reads the way an agent would navigate the code and materialises onto the board with no
translation. The decomposition tree lives in `core/src/modules/boardScan` (the
framework-agnostic `BoardScanService` + pure `board-scan.logic` coercion/rendering);
the persisted blueprints are stored in D1 (migration `0011_repo_blueprints.sql`).

Like GitHub/Confluence/bootstrap it is **layered and opt-in at the edges**: reading
blueprints always works (the `RepoBlueprintRepository` is wired unconditionally), while
running a scan needs the `RepoScanner` port — a per-run Cloudflare Container
(`ContainerRepoScanner`) that clones the repo read-only and has a scanner agent produce
the blueprint, gated on the same prerequisites as the implementation container (the
`EXEC_CONTAINER` binding, a configured GitHub App, `WORKER_PUBLIC_URL` and
`AUTH_SESSION_SECRET`). Without it the scan endpoint reports itself unavailable.

## Prompt-fragment library (optional)

Agents compose their system prompt from a catalog of **best-practice fragments**.
The built-in tier ships as code in
[`@cat-factory/prompt-fragments`](./packages/prompt-fragments/README.md); on top
of it the `fragmentLibrary` module (migration `0020_prompt_fragments.sql`) adds a
**tenant-scoped, editable** catalog. A resolved catalog is the merge of three
tiers — **built-in ∪ account ∪ workspace** — later tiers overriding earlier ones
by stable `id` (and a tombstone row suppresses one). Fragments can be
hand-authored or **sourced from a repo** (Markdown + YAML frontmatter), tracked
with a sync cursor (`source_sha`) so "check for changes" is a cheap comparison.

At run time a `FragmentSelector` picks the **relevant** subset for the PR/diff at
hand (LLM-picked from summaries, with a deterministic `tags`/`appliesTo`
fallback), unioned with any ids the user pinned on the block — so reviews are
sharper and cheaper. `composeSystemPrompt` is unchanged. Opt-in via
`PROMPT_LIBRARY_ENABLED` (selector mode `PROMPT_LIBRARY_SELECTOR = llm |
deterministic`); when off, the static built-in catalog and the manual
`block.fragmentIds` flow are untouched. Design + data model in
[ADR 0006](./docs/adr/0006-prompt-fragment-library.md).

## Self-hosted runner pool (optional)

By default the repo-operating coding jobs (`coder`, `mocker`, `playwright`) run in
per-run Cloudflare Containers. A workspace can instead **bring its own**
container/runner pool (Kubernetes, Nomad, an internal scheduler): you run the
standard executor-harness image and put a small **pool scheduler API** in front
of it, described to cat-factory as a declarative **manifest** (dispatch / poll /
release templates + auth + response dot-paths). The `runners` module
(migration `0013_runner_pools.sql`) stores the manifest plus a per-tenant secret
bundle **encrypted at rest** (AES-256-GCM under `RUNNERS_ENCRYPTION_KEY`); the
`HttpRunnerPoolProvider` dispatches jobs there instead. Rollout is per-workspace
and reversible — workspaces without a registered pool fall back to Cloudflare
Containers. Opt-in via `RUNNERS_ENABLED`. Operator playbook in
[`docs/runner-pool-integration.md`](./docs/runner-pool-integration.md);
rationale in [ADR 0004](./docs/adr/0004-self-hosted-runner-pool.md).

> Scope (v1): only the async coding jobs route to a self-hosted pool. Repo
> **bootstrap** and **scan** still use Cloudflare Containers.

## Persistence & migrations

On the **Cloudflare Worker** facade all state lives in one Cloudflare **D1**
database (`cat_factory`, bound as `DB`). Migrations are plain SQL under
[`runtimes/cloudflare/migrations`](./runtimes/cloudflare/migrations), applied with
`wrangler d1 migrations apply`. The model has grown from `0001_init.sql` (core
boards/blocks/pipelines/executions) through, notably:

- `0003_token_usage`, `0006_storage_retention` — spend ledger + retention.
- `0004_github_projections`, `0019_github_installation_app` — GitHub projections + two-app tiering.
- `0008_environments`, `0011_repo_blueprints`, `0012_document_sources`, `0013_runner_pools`, `0014_task_sources` — the opt-in integrations.
- `0010_bootstrap` (+ `0017_bootstrap_board`, `0018_bootstrap_failure`), `0017_accounts`, `0019_agent_runs` — bootstrap, tenancy, and the unified `agent_runs` table.
- `0020_prompt_fragments`, `0021_requirement_reviews` — the prompt-fragment library and requirements review.

Agent runs for **both** container flows (task `execution` and repo `bootstrap`)
share one kind-scoped `agent_runs` table, so failure + retry surface uniformly
and a cron **sweeper** can re-drive stale runs of either kind. How the data is
swept/retained is in [`docs/storage-and-retention.md`](./docs/storage-and-retention.md);
how per-run containers get reclaimed (and where that still leaks) is in
[`docs/container-reaping.md`](./docs/container-reaping.md).

The **Node.js** facade (`runtimes/node`) maps the same logical schema onto
**Postgres** via Drizzle (`src/db/schema.ts`; `migrate()` bootstraps it idempotently
from `DATABASE_URL` on boot), reusing the dialect-agnostic row↔domain mappers from
`@cat-factory/server`. The two stores are kept semantically in sync and pinned to
identical behaviour by the cross-runtime conformance suite (`@cat-factory/conformance`).

## HTTP API (selected)

```
GET    /models                                               model picker catalog (effective flavours)

POST   /workspaces                                            create board (optionally seeded)
GET    /workspaces                                            list boards
GET    /workspaces/:ws                                        full snapshot (blocks, pipelines, executions)
DELETE /workspaces/:ws

POST   /workspaces/:ws/blocks                                 add frame
POST   /workspaces/:ws/blocks/:id/tasks                       add task
POST   /workspaces/:ws/blocks/:id/modules                     add module
PATCH  /workspaces/:ws/blocks/:id                             update
POST   /workspaces/:ws/blocks/:id/move                        move
POST   /workspaces/:ws/blocks/:id/reparent                   move into a container
POST   /workspaces/:ws/blocks/:id/dependencies               toggle a dependency edge
DELETE /workspaces/:ws/blocks/:id                             delete (cascades)

GET    /workspaces/:ws/pipelines
POST   /workspaces/:ws/pipelines
DELETE /workspaces/:ws/pipelines/:id

POST   /workspaces/:ws/blocks/:id/executions                 start a pipeline run
DELETE /workspaces/:ws/blocks/:id/executions                 cancel
POST   /workspaces/:ws/blocks/:id/merge                       merge an open PR
POST   /workspaces/:ws/executions/:exec/decisions/:dec        resolve a human decision
GET    /workspaces/:ws/events                                 WebSocket: live execution/board events

GET    /workspaces/:ws/spend                                  current spend vs budget for the period
POST   /workspaces/:ws/spend/resume                           resume runs paused by the spend cap

# GitHub integration (only when a GitHub App is configured)
POST   /github/webhooks                                       verified webhook receiver (GitHub-facing)
GET    /github/setup/callback                                 App install callback (browser-facing)
GET    /workspaces/:ws/github/install-url                     signed App install URL
GET    /workspaces/:ws/github/connection                      current connection (or null)
POST   /workspaces/:ws/github/connect                         bind an installation { installationId }
DELETE /workspaces/:ws/github/connection                      disconnect
POST   /workspaces/:ws/github/resync                          resync { repoGithubId?, full? }
GET    /workspaces/:ws/github/repos                           projected repos
GET    /workspaces/:ws/github/repos/:repoId/branches          projected branches
GET    /workspaces/:ws/github/pulls                           projected pull requests
GET    /workspaces/:ws/github/issues                          projected issues
POST   /workspaces/:ws/github/repos/:repoId/branches          create a branch
POST   /workspaces/:ws/github/repos/:repoId/commits           commit files (Git Data API)
POST   /workspaces/:ws/github/repos/:repoId/pulls             open a pull request
PUT    /workspaces/:ws/github/repos/:repoId/pulls/:n/merge    merge a pull request
POST   /workspaces/:ws/github/repos/:repoId/issues/:n/comments  comment on an issue/PR

# Ephemeral environments (only when ENVIRONMENTS_ENABLED + encryption key are set)
GET    /workspaces/:ws/environments/connection                  registered provider (safe metadata)
POST   /workspaces/:ws/environments/connection                  register manifest + secret bundle
PUT    /workspaces/:ws/environments/connection/secrets          rotate the secret bundle
DELETE /workspaces/:ws/environments/connection                  unregister
GET    /workspaces/:ws/environments                             list provisioned environments
GET    /workspaces/:ws/environments/:id                         one environment (no creds)
GET    /workspaces/:ws/environments/:id/access                  decrypted access creds (TLS only)
POST   /workspaces/:ws/environments/provision                   manually provision { blockId?, inputs? }
POST   /workspaces/:ws/environments/:id/teardown                tear down now

# On-demand board scan (blueprint reads always; scanning needs the container + GitHub App)
GET    /workspaces/:ws/board-scan/blueprints                    list persisted repository blueprints
GET    /workspaces/:ws/board-scan/blueprints/:id                one blueprint (service → modules → features)
DELETE /workspaces/:ws/board-scan/blueprints/:id                forget a blueprint
POST   /workspaces/:ws/board-scan/scans                          scan { repoOwner, repoName, instructions?, spawn? }

# Accounts & tenancy
GET    /accounts                                             accounts the signed-in user can act within
GET    /accounts/:id/workspaces                              boards owned by an account

# Unified agent runs (execution + bootstrap failure/retry surface)
POST   /workspaces/:ws/agent-runs/:id/retry                  retry a failed run (resolves kind)
POST   /workspaces/:ws/agent-runs/:id/stop                   stop a run (reclaims its container)

# Requirements review (stateless, synchronous — no container)
GET    /blocks/:blockId/requirement-review                   current review for a block (or null)
POST   /blocks/:blockId/requirement-review                   run a new review (replaces the prior one)
POST   /requirement-reviews/:id/items/:itemId/reply          answer an item
PATCH  /requirement-reviews/:id/items/:itemId                set item status (resolve/dismiss)
POST   /requirement-reviews/:id/incorporate                  fold settled answers into the description

# Repo bootstrap (managing reference architectures always; running needs the container + GitHub App)
GET    /workspaces/:ws/bootstrap/reference-architectures     list reference architectures
POST   /workspaces/:ws/bootstrap/reference-architectures     CRUD reference architectures
POST   /workspaces/:ws/bootstrap/jobs                         start a bootstrap run (returns a running job)
GET    /workspaces/:ws/bootstrap/jobs/:id                     poll a bootstrap job

# Document sources (always on; requires DOCUMENTS_ENCRYPTION_KEY at boot)
GET    /workspaces/:ws/documents/sources                     connected document sources
POST   /workspaces/:ws/documents/sources                     connect a source (Confluence / Notion)
POST   /workspaces/:ws/documents/import                      import a page
POST   /workspaces/:ws/documents/spawn                       expand a document into board structure
POST   /workspaces/:ws/documents/link                        attach a document to a block

# Task sources (issue trackers)
GET    /workspaces/:ws/tasks/sources                         connected task sources
POST   /workspaces/:ws/tasks/sources                         connect a tracker (Jira / Linear / GH Issues)
POST   /workspaces/:ws/tasks/import                          import issues
POST   /workspaces/:ws/tasks/link                            link an issue to a block

# Prompt-fragment library (built-in catalog always; tiers when PROMPT_LIBRARY_ENABLED)
GET    /prompt-fragments                                     built-in catalog (static)
GET    /:scope/prompt-fragments                              tier fragments (:scope = accounts/:id | workspaces/:id)
POST   /:scope/prompt-fragments                              create a hand-authored fragment
PATCH  /:scope/prompt-fragments/:fragmentId                  edit / suppress
DELETE /:scope/prompt-fragments/:fragmentId                  tombstone
GET    /:scope/fragment-sources                              linked guideline repos + last-synced state
POST   /:scope/fragment-sources                              link a repo dir { repo, ref, dirPath }
GET    /:scope/fragment-sources/:id/status                   check-for-changes (no writes)
POST   /:scope/fragment-sources/:id/sync                     resync now
GET    /workspaces/:ws/prompt-fragments/resolved             merged builtin ∪ account ∪ workspace

# Self-hosted runner pool (only when RUNNERS_ENABLED + encryption key are set)
GET    /workspaces/:ws/runner-pool/connection                current binding (safe metadata)
POST   /workspaces/:ws/runner-pool/connection                register/replace manifest + secrets
PUT    /workspaces/:ws/runner-pool/connection/secrets        rotate the secret bundle
DELETE /workspaces/:ws/runner-pool/connection                unregister
```

## Develop & test

```bash
pnpm install

# run the Worker locally (applies migrations to a local D1 on first request)
pnpm --filter @cat-factory/worker db:migrate:local
pnpm dev

# integration tests — real workerd + real local D1 (no mocking of infra)
pnpm test
```

Integration tests run via `@cloudflare/vitest-pool-workers` inside the same runtime Wrangler uses,
against a real local D1 database with the real migrations applied. Only the LLM is faked
(deterministically); the storage and HTTP stack are real.

### Deploying

This package is a **library**; it carries no production config. Deployment is
driven from the example **deployment** package
[`deploy/backend`](../../deploy/backend), which re-exports this library's handler
and holds the `wrangler.toml`, the per-deployment `[vars]`, and the secrets. The
end-to-end walkthrough (deploy order, migrations, the reference URLs) lives in the
[top-level README → Deployment](../README.md#deployment) and
[`deploy/backend/README.md`](../../deploy/backend/README.md). **This section is the
configuration reference**: what every var/secret does and how to turn each opt-in
feature on. The canonical, fully-commented list of bindings + vars is the typed
`Env` in [`runtimes/cloudflare/src/infrastructure/env.ts`](./runtimes/cloudflare/src/infrastructure/env.ts).

The short path, from `deploy/backend`:

```sh
wrangler d1 create cat_factory          # paste the id into wrangler.toml [[d1_databases]]
pnpm db:migrate:remote                   # wrangler d1 migrations apply cat_factory --remote
# set the required auth secrets (below), then:
pnpm deploy                              # builds @cat-factory/worker, then wrangler deploy
```

Agents always perform **real** work — an unpinned block defaults to the Qwen
model on the Workers AI (`AI`) binding, so a minimal deployment needs **no
provider key**. Setting a direct-provider key simply upgrades that model to its
own API (see "Model picker" below).

#### What is a `[vars]` entry vs a secret

Two different `wrangler` mechanisms, and getting them confused is the most common
mistake:

- **`[vars]`** — non-secret config, committed in `wrangler.toml`. Origins,
  ids, slugs, feature toggles, budgets. Visible in the dashboard.
- **Secrets** — `wrangler secret put NAME` (never committed). Private keys,
  OAuth/client and HMAC secrets, provider API keys, the per-feature encryption
  master keys. Locally these go in `.dev.vars` (gitignored; see
  `deploy/backend/.dev.vars.example`).

| `[vars]` (in `wrangler.toml`)                                                                                                           | Secrets (`wrangler secret put …`)                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_OAUTH_CLIENT_ID`, `AUTH_ALLOWED_LOGINS`/`AUTH_ALLOWED_ORGS`, `AUTH_SUCCESS_REDIRECT_URL`, `ENVIRONMENT`, `CORS_ALLOWED_ORIGINS` | `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_SESSION_SECRET`                                                                                                                                        |
| `WORKER_PUBLIC_URL`, `RUNNERS_ENABLED`                                                                                                  | (container/runner path holds no key of its own — see below)                                                                                                                                |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_SETUP_REDIRECT_URL`, `GITHUB_PRIVILEGED_APP_ID`                                             | `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`                                                                                                     |
| `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`, `SPEND_MODEL_PRICES`, `AGENT_DEFAULT_*`/`AGENT_MODELS`, `DECISION_TIMEOUT`                     | `QWEN_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`                                                                                              |
| `DOCUMENT_SOURCES`/`DOCUMENT_PLANNER`, `TASK_SOURCES`, `ENVIRONMENTS_ENABLED`, `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`       | `DOCUMENTS_ENCRYPTION_KEY`, `TASKS_ENCRYPTION_KEY` (both **required** — always-on integrations, config fails loudly without them), `ENVIRONMENTS_ENCRYPTION_KEY`, `RUNNERS_ENCRYPTION_KEY` |

> `WORKER_PUBLIC_URL` is a **`[var]`, not a secret**, despite older notes that
> said otherwise. Set it in `[vars]`.

#### Authentication (required in production)

The API **fails closed**: every route except a small public allowlist (`/health`, `/auth/*`, the
`/v1` container proxy, and `/github` webhooks) requires a signed-in session, and when auth is
unconfigured those routes return `503 auth_not_configured` rather than serving data. **A production
deployment without auth configured is locked, not open** — so this is a required setup step, not an
optional one.

Register a GitHub OAuth app (a GitHub App's OAuth credentials or a classic OAuth App) with the
callback URL `<worker-origin>/auth/callback`, then:

```sh
# wrangler.toml [vars]
GITHUB_OAUTH_CLIENT_ID = "Iv1.abc123…"

# secrets
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler secret put AUTH_SESSION_SECRET            # any high-entropy random string

# recommended in production (see docs/auth.md):
#   AUTH_SUCCESS_REDIRECT_URL = "https://<your-spa>"   # fixed post-login landing

# REQUIRED — sign-in allowlist, fails closed (set at least one; see docs/auth.md):
#   AUTH_ALLOWED_LOGINS = "octocat,hubot"      # admit these GitHub users, OR…
#   AUTH_ALLOWED_ORGS   = "acme-inc"           # …any member of these GitHub orgs
# Both empty => nobody can sign in. The two lists combine as an OR allowlist.
```

Local dev and the test suite run open via the `AUTH_DEV_OPEN=true` escape hatch (in `.dev.vars`,
gitignored, and the vitest bindings) — **never set it in the deployed `wrangler.toml`**, as that
would re-open production. As belt-and-braces, set `ENVIRONMENT = "production"` in the deployed
`[vars]`: when the environment is production-like the worker **refuses** the `AUTH_DEV_OPEN` hatch
even if it leaks in, so a stray dev flag can't re-open a live deployment. Full details, the OAuth
flow, and all optional vars are in [`docs/auth.md`](./docs/auth.md).

> Note: this "Login with GitHub" user authentication is distinct from the optional **GitHub App
> integration** below (how a workspace acts on repos); they use different credentials.

#### Model picker and provider keys

The inspector's "Model" picker lets each block choose a model; the default is **Qwen**. Every model
has two flavours and resolves automatically:

- **No key set →** the model runs on **Cloudflare Workers AI** (the `AI` binding) and the picker
  shows it as the _Cloudflare_ flavour.
- **Provider key set →** the same model is transparently replaced by its **direct** provider API and
  shown as the _direct_ flavour (Llama has no direct variant and always runs on Cloudflare).

Set the direct-provider keys as secrets in production to enable the direct flavours:

```sh
wrangler secret put QWEN_API_KEY       # Qwen → Alibaba DashScope (intl endpoint)
wrangler secret put DEEPSEEK_API_KEY   # DeepSeek → DeepSeek API
wrangler secret put MOONSHOT_API_KEY   # Kimi → Moonshot AI
# Optional first-party providers used by AGENT_MODELS overrides:
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

The effective catalog (which flavour is active) is served read-only at `GET /models`; it exposes
only labels and provider/model ids, never the keys.

#### Container implementation (running agents on a real checkout)

The phases that must operate on the repository — `coder` (implementation), `mocker` (WireMock
mocks) and `playwright` (end-to-end tests) — run inside a per-run Cloudflare Container that
clones the repo, edits files and opens a PR, instead of as a single inline LLM call. Every other
phase (architect, reviewer, tester, the `acceptance` scenario writer, …) stays inline. This is
**always on** — there is no opt-out flag — so its prerequisites are mandatory and the Worker
**fails to start** if any is missing:

```toml
# wrangler.toml [vars] (WORKER_PUBLIC_URL is a var, not a secret)
WORKER_PUBLIC_URL = "https://cat-factory-backend.<account>.workers.dev"
# Also requires the EXEC_CONTAINER binding + [[containers]] image (already in wrangler.toml),
# a configured GitHub App, and AUTH_SESSION_SECRET. (A registered self-hosted runner pool can
# stand in for the EXEC_CONTAINER binding.) Container runs are long-lived; the Workflows driver
# carries them.
```

> **`WORKER_PUBLIC_URL` must be the `*.workers.dev` origin, _not_ an orange-clouded
> custom domain.** A per-run Container egresses from inside Cloudflare's network, so
> a zone's WAF / Bot-Fight rules block its POSTs to the LLM proxy with a `403 …
blocked.` before the Worker even runs (browsers pass the bot checks, so the SPA is
> unaffected). `workers.dev` isn't in that zone, so the container reaches the proxy
> unblocked. The container image is pinned by the `[[containers]].image` GHCR tag —
> use a version tag, not `latest`, for reproducible deploys.

The container never holds a provider key: it reaches models only through this Worker's LLM proxy
(`/v1/chat/completions`) using a short-lived, model-locked session token, and the proxy is the
single spend-metering point.

**No extra LLM secret is required.** With no direct-provider key set, blocks resolve to their
**Workers AI** flavour, and the proxy serves those in-process through the Worker's `AI` binding —
so container runs work out of the box on Workers AI. Setting a direct-provider key (above) simply
upgrades the same blocks to that provider; the proxy then forwards to its OpenAI-compatible
endpoint instead. Either way the container is unchanged and holds no credentials.

##### Web search (optional; same key-out-of-the-sandbox seam)

Container agents (coder / ci-fixer / mocker / …) can use `web_search` / `web_fetch` (the
`@juicesharp/rpiv-web-tools` Pi extension in the image), and — exactly like the LLM proxy —
**no search key enters the container**. The Worker hosts a SearXNG-compatible **web-search proxy**
at `${WORKER_PUBLIC_URL}/v1/web-search`; the container reaches it with the **same** model-locked
session token it uses for the LLM proxy, and the Worker runs the search server-side under the
deployment's own key (the `webSearch` runtime gateway). Enable it by setting **one** upstream on
the Worker (not in the container):

- `WEB_SEARCH_BRAVE_API_KEY` — Brave Search (recommended; what Claude Code uses), **or**
- `WEB_SEARCH_SEARXNG_URL` (+ optional `WEB_SEARCH_SEARXNG_API_KEY`) — reverse-proxy to a
  self-hosted SearXNG instance.

Off by default: with neither set, `/v1/web-search` replies 503 and container runs behave exactly as
before. When configured, `ContainerAgentExecutor` flags the coding/ci-fixer job and the harness
points the extension's SearXNG provider at the proxy (the session token as its bearer). The two web
tools count as read-only exploration for the no-edit guard, but a dedicated cap
(`JOB_MAX_CONSECUTIVE_WEB_CALLS`, default 25) stops a search rabbit-hole. Adding another search
vendor is a new `WebSearchUpstream` implementation behind the gateway — the container side never
changes. (A **self-hosted runner pool** controls its own container env, so it may instead set any
`rpiv-web-tools` provider key — `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `SEARXNG_URL`, … —
directly; the harness auto-detects it.)

Separately, the **inline** design/research agents (architect / researcher) can use the
provider-hosted `web_search` tool on Anthropic / OpenAI models via `INLINE_WEB_SEARCH_ENABLED`
(see `INLINE_WEB_SEARCH_KINDS` / `INLINE_WEB_SEARCH_MAX_USES`); it is a no-op on other providers.

#### Repo bootstrap (creating a new repo from a reference architecture)

The "bootstrap repo" task adapts a reference architecture (or scaffolds from scratch) into a
pre-created, empty GitHub repo and force-pushes the result, running the bootstrapper agent
inside a per-run container. The run is **asynchronous and observable**, mirroring the execution
pipeline: `POST /bootstrap/jobs` returns immediately with a `running` job and materialises a
provisional **service frame** on the board; a durable `BootstrapWorkflow` (binding
`BOOTSTRAP_WORKFLOW`, declared in `wrangler.toml` like `EXECUTION_WORKFLOW`) polls the container,
streams live subtask progress over the WebSocket events hub, and on success links the new repo to
that frame so it becomes a real, droppable service (on failure the frame is marked blocked). See
[`CLAUDE.md`](../CLAUDE.md) for the end-to-end flow. Managing reference architectures (the CRUD
under `/bootstrap/reference-architectures`) always works, but **kicking off a run** needs the same
machinery as container implementation. When
any prerequisite is missing the endpoint returns:

```json
{
  "error": {
    "code": "unavailable",
    "message": "Repo bootstrapping needs the GitHub App and the implementation container to be configured"
  }
}
```

To enable the run path, all of the following must be present (see `selectRepoBootstrapper` in
`src/infrastructure/container.ts`):

| Prerequisite             | Kind     | How to set it                                                                                                                                       |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXEC_CONTAINER` binding | binding  | declared in `wrangler.toml` — the per-run container _factory_, not a shared instance (see below)                                                    |
| `GITHUB_APP_ID`          | `[vars]` | App id in `wrangler.toml [vars]` (with `GITHUB_APP_SLUG`)                                                                                           |
| `GITHUB_APP_PRIVATE_KEY` | secret   | `wrangler secret put GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM)                                                                                           |
| `GITHUB_WEBHOOK_SECRET`  | secret   | `wrangler secret put GITHUB_WEBHOOK_SECRET`                                                                                                         |
| `WORKER_PUBLIC_URL`      | `[vars]` | a `wrangler.toml [vars]` entry, e.g. `WORKER_PUBLIC_URL = "https://cat-factory-backend.<account>.workers.dev"` — it's a public origin, not a secret |
| `AUTH_SESSION_SECRET`    | secret   | `wrangler secret put AUTH_SESSION_SECRET` (already required for auth)                                                                               |

`EXEC_CONTAINER` is the Durable Object **namespace** binding, not a single long-lived container.
Each run derives its own instance — `container.get(container.idFromName(jobId))` — so containers
are spun up **on demand, one per job**, up to the `[[containers]] max_instances` ceiling in
`wrangler.toml`, and Cloudflare reclaims (spins down) each idle instance once its run finishes.
The gate above only checks that this factory binding is wired into the deployment; you can't spin
containers up dynamically without it declared at deploy time.

```sh
# Secrets (shared with the GitHub integration / auth):
wrangler secret put GITHUB_APP_PRIVATE_KEY   # PKCS#8 PEM
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put AUTH_SESSION_SECRET

# Non-secret config — set in wrangler.toml [vars], not as secrets:
#   GITHUB_APP_ID = "..."          (with GITHUB_APP_SLUG)
#   WORKER_PUBLIC_URL = "https://cat-factory-backend.<account>.workers.dev"
# plus the EXEC_CONTAINER binding (already declared in wrangler.toml).
```

Bootstrap needs the same runner backend as container implementation — the `EXEC_CONTAINER`
binding (or a registered runner pool). Like the container executor, the bootstrapper holds no
provider key: the agent reaches models only through this Worker's LLM proxy with a short-lived
session token.

#### GitHub App integration (acting on repos)

Distinct from "Login with GitHub" above — this is how a **workspace acts on repos**
(read/write repos, branches, PRs, issues; webhooks). Off until an App is configured.
Register a GitHub App, then:

```toml
# wrangler.toml [vars]
GITHUB_APP_ID = "…"
GITHUB_APP_SLUG = "your-app-slug"
GITHUB_SETUP_REDIRECT_URL = "https://<your-spa>"   # where to land the browser after install
```

```sh
wrangler secret put GITHUB_APP_PRIVATE_KEY   # PKCS#8 PEM
wrangler secret put GITHUB_WEBHOOK_SECRET    # HMAC secret for /github/webhooks
```

By default the webhook endpoint applies projection updates **inline**. For the
fast-ack async path, create the sync queues and uncomment the `[[queues.*]]` blocks
in `wrangler.toml` (`wrangler queues create cat-factory-github-sync` + `…-dlq`).
Design + runbook: [`docs/github-integration.md`](./docs/github-integration.md) ·
[`docs/github-operations.md`](./docs/github-operations.md).

**Creating repos directly (two-app tier, opt-in).** Programmatic repo creation
needs `Administration: write`, which most installs shouldn't carry. So register a
**second**, privileged App and configure it alongside the restricted default one;
orgs opt in by installing it, and only then does the bootstrap modal create repos
directly (otherwise it delegates to GitHub's new-repo page). See
[ADR 0005](./docs/adr/0005-two-app-repo-provisioning.md).

```toml
GITHUB_PRIVILEGED_APP_ID = "…"
```

```sh
wrangler secret put GITHUB_PRIVILEGED_APP_PRIVATE_KEY   # PKCS#8 PEM
```

#### Opt-in integrations (encrypted-credential features)

The document-source, task-source, ephemeral-environment, and self-hosted runner-pool
integrations are all **default-off** and **per-workspace**: an operator flips a single
`[vars]` flag to enable the feature, and each workspace then enters its own provider
credentials **in the app**, stored **encrypted at rest** in D1. So the only deployment
secret each one needs is a service-level **encryption master key** (base64, ≥32 bytes
decoded) — there are **no provider credentials in `wrangler.toml`**. Generate with
`openssl rand -base64 32`.

| Feature                 | Enable (`[vars]`)                                    | Master-key secret                         | Docs                                                           |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Document sources        | always on (+ `DOCUMENT_SOURCES`, `DOCUMENT_PLANNER`) | `DOCUMENTS_ENCRYPTION_KEY` (**required**) | [document-sources](./docs/document-sources.md)                 |
| Task sources (trackers) | always on (+ `TASK_SOURCES`)                         | `TASKS_ENCRYPTION_KEY` (**required**)     | README → Document & task sources                               |
| Ephemeral environments  | `ENVIRONMENTS_ENABLED = "true"`                      | `ENVIRONMENTS_ENCRYPTION_KEY`             | [environments-integration](./docs/environments-integration.md) |
| Self-hosted runner pool | `RUNNERS_ENABLED = "true"`                           | `RUNNERS_ENCRYPTION_KEY`                  | [runner-pool-integration](./docs/runner-pool-integration.md)   |

> Document and task sources are **always on** (tenants connect their own
> sources/trackers through the UI), so they have no enable flag — but the worker
> **refuses to boot** until their master keys are set, instead of silently dropping
> the feature from the task-creation modal.

```sh
openssl rand -base64 32 | wrangler secret put DOCUMENTS_ENCRYPTION_KEY      # repeat per enabled feature
```

The **runner pool** routes the repo-operating coding jobs to a workspace's own
infra instead of Cloudflare Containers; when enabled, a registered pool can serve as
the mandatory runner backend in place of the `EXEC_CONTAINER` binding. Like the
container path, it still needs a configured GitHub App, `WORKER_PUBLIC_URL`
and `AUTH_SESSION_SECRET`.

The **prompt-fragment library** is the one opt-in feature that needs **no** key
(guidelines aren't secrets, and repo reads reuse the account's GitHub installation):

```toml
PROMPT_LIBRARY_ENABLED = "true"
PROMPT_LIBRARY_SELECTOR = "deterministic"   # or "llm" to pick relevant fragments per run
```
