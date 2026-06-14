# ADR 0002: Cloudflare as the runtime platform, not a containerized Node app

- **Status:** Accepted
- **Date:** 2026-06-14
- **Context layer:** whole system (`@cat-factory/worker`, `@cat-factory/core`, Nuxt frontend)

## Context

cat-factory is a software-development agent management platform. The backend has
to do several things that, on a traditional stack, each pull in their own piece
of infrastructure:

- serve an HTTP API (`@cat-factory/worker`, Hono);
- persist workspaces, boards, pipelines, executions, token-usage ledgers and
  GitHub projections (relational data);
- run agent pipelines as **long-lived, durable** processes that survive restarts
  and park on human decisions for up to ~24h;
- ingest GitHub webhooks with a fast ack and asynchronous processing;
- run a periodic reconciler/sweeper;
- call LLMs from several providers and meter their spend.

The conventional way to assemble this is a Node app — Express/Fastify + an ORM —
packaged into a Docker image and run "somewhere" (a VM, ECS/Fargate, a Kubernetes
deployment, Fly, Render, etc.), wired to a managed Postgres, a Redis/queue broker
for background work, a separate worker process or queue consumer for durable jobs,
and a cron scheduler. That works, but every one of those is a separately
provisioned, separately scaled, separately billed, separately monitored moving
part — glue the team owns before writing a line of product code.

This ADR records why we instead chose the **Cloudflare developer platform** as a
single, cohesive runtime, and what we accept in return.

## Decision

Run the entire backend as a **Cloudflare Worker** and lean on Cloudflare's
first-party primitives for everything the app needs, rather than assembling
independent ecosystem pieces inside a container:

| Need                           | Cloudflare primitive                                          | Traditional-stack equivalent it replaces      |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| HTTP API                       | Worker + Hono (`src/index.ts`, `src/app.ts`)                  | Node + Express/Fastify in a container         |
| Relational store               | **D1** (binding `DB`, `migrations/`)                          | managed Postgres/MySQL + connection pool      |
| Durable, long-running runs     | **Workflows** (`ExecutionWorkflow`, `GitHubBackfillWorkflow`) | a separate worker process + a job/state store |
| Async work / fast-ack webhooks | **Queues** (`GITHUB_SYNC_QUEUE`, `EXECUTION_QUEUE`)           | Redis/SQS/RabbitMQ + consumer process         |
| Scheduling                     | **Cron triggers** (sweeper, every 2 min)                      | a cron container or scheduler service         |
| LLM inference                  | **Workers AI** binding (`AI`) + AI SDK providers              | a separately hosted inference endpoint        |
| Config & secrets               | `wrangler.toml` `[vars]` + `wrangler secret put`              | env files / a secrets manager                 |
| Deploy artifact                | `wrangler deploy` (no image)                                  | build, push and run a Docker image            |

The frontend is a Nuxt **SPA** (`ssr: false`) that talks to the Worker over its
public API base — naturally hostable on Cloudflare Pages, so the same platform and
deploy story covers both tiers.

## Rationale

### 1. One platform, one deploy, no image to build or host

There is no Dockerfile, no base-image patching, no registry, no orchestrator, and
nothing to keep "running somewhere." `wrangler deploy` ships the code; bindings in
`wrangler.toml` declare every dependency the Worker can reach. The set of moving
parts a traditional deployment would provision separately — app server, database,
queue broker, durable-job worker, cron scheduler, inference endpoint — collapses
into one configuration file and one deploy command. Local development mirrors
production through `wrangler dev` and `wrangler d1 migrations apply --local`,
including a real D1 instance, rather than a `docker-compose` stack of stand-ins.

### 2. Durable execution without owning a job system

Agent runs are the hard part: they are long-lived, must survive process restarts,
and can block on a human decision for ~24h. On a container stack that means a
durable workflow/job engine (Temporal, BullMQ + Redis, a state machine in
Postgres) plus a worker process to run it. **Cloudflare Workflows** gives us
durable, server-driven execution as a platform primitive: each pipeline run is one
Workflow instance (the only execution path), with the cron sweeper as a backstop
that re-drives instances whose execution died. No broker, no standing worker
fleet, no separate scaling axis.

### 3. Data and queues as bindings, not network services

D1 is an in-platform SQLite database reached through a binding — no connection
pool to size, no pool exhaustion under Workers' high concurrency, no separate
database host to secure and back up. Queues are likewise a binding, letting the
GitHub webhook endpoint verify-and-ack fast (`202`) and offload projection work
asynchronously (see ADR 0001). Notably these are **opt-in**: when a queue binding
is absent (local/tests, or a smaller deployment) the Worker applies the same work
inline. The architecture degrades to a single process without code changes —
something a hard dependency on Redis/SQS would not allow.

### 4. Provider-agnostic where it matters; native where it helps

The platform bet does not lock the product to Cloudflare's AI. The LLM seam is a
provider-agnostic port: `CloudflareModelProvider` resolves a `ModelRef` to a
concrete model and can route to **OpenAI**, **Anthropic**, or **Workers AI**
through the Vercel AI SDK. Workers AI is the convenient default (`@cf/meta/
llama-3.1-8b-instruct`, no external key, billed on-platform), while external
providers remain a config switch away. We get the integration convenience without
sacrificing model choice.

### 5. Operational profile and cost

Workers scale to zero and bill per request rather than per always-on container or
VM. For a multi-tenant tool with bursty, human-paced workloads this fits the usage
shape far better than paying for idle compute. There is no OS, runtime, or base
image to keep patched, and the global edge deployment is the default rather than an
add-on.

## Alternatives considered

- **Node + Express/Fastify + Postgres in Docker on a PaaS/Kubernetes.** The
  industry default and the most flexible (full Node API surface, any npm package,
  any database). Rejected as the _primary_ runtime because it reintroduces exactly
  the assembly-and-operate burden this decision avoids: an image pipeline, a
  managed database, a separate broker and durable-job worker, a scheduler, and the
  monitoring/scaling/patching of each. The product gains nothing from owning that
  glue.
- **Serverless functions (AWS Lambda et al.) + managed Postgres + SQS +
  Step Functions.** Removes the container but not the _fragmentation_ — durable
  execution, queueing, scheduling, data and secrets are still distinct services
  stitched together with IAM, and Lambda's connection model fights relational
  pools. Cloudflare offers the same capabilities as one cohesive, binding-based
  platform.
- **A long-running Node worker process alongside the API** for durable runs.
  This is what Workflows replaces; it would mean operating a second deployable and
  its own restart/state-recovery story.

## Consequences

- **Runtime constraints are real and shape the code.** The Worker runtime is not
  Node. We rely on `nodejs_compat` and deliberately prefer Web-standard APIs —
  e.g. `crypto.subtle` for RS256/HMAC instead of Node `crypto`, and a thin `fetch`
  GitHub client instead of Octokit (ADR 0001). Bundle size and CPU-time limits
  per request constrain what we pull in; heavyweight or Node-only libraries may not
  be usable.
- **Some coupling to Cloudflare is accepted.** D1, Workflows, Queues and Workers AI
  are platform-specific. We contain the blast radius behind hexagonal ports
  (repositories, `ModelProvider`, the GitHub client), so the **core** stays
  portable and the Cloudflare specifics live in `infrastructure/`. A future move
  off-platform would mean rewriting adapters, not the domain.
- **The platform's maturity and quotas are now a project risk.** D1 size/throughput
  limits, Workflows behavior, and per-request CPU limits bound the design; we track
  them as platform constraints rather than something we can scale our way out of by
  resizing a container.
- **Local/dev parity is high but not total.** `wrangler dev` runs the real runtime
  and a local D1, which is closer to production than a mocked container stack — but
  queue-consumer wiring differs in tests (consumers are opt-in; work runs inline),
  so that path is exercised by integration rather than by the default local run.
