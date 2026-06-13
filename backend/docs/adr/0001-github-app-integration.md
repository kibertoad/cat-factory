# ADR 0001: GitHub integration via a GitHub App

- **Status:** Accepted
- **Date:** 2026-06-13
- **Context layer:** backend (`@cat-factory/core`, `@cat-factory/worker`)

## Context

cat-factory needs to read and write GitHub repositories on behalf of many
workspaces, maintain local projections of frequently-read GitHub data, resync
those projections, and react to GitHub webhooks. The backend runs on Cloudflare
Workers (Hono + D1 + Workflows + Queues + cron) in a hexagonal monorepo. There was
no prior GitHub code, webhook handling, caching layer, or user auth.

## Decisions

### 1. Access model: a GitHub App (multi-tenant), not OAuth App or PAT

A GitHub App is the only model that simultaneously provides multi-tenant credential
isolation, read **and** write, and native webhooks. Each workspace maps to one App
**installation**; the installation access token is the per-workspace credential.

- **OAuth App** issues user-scoped tokens (no per-installation isolation) and needs
  per-repo webhook configuration.
- **PATs** (classic / fine-grained) are single-user with manual rotation —
  unsuitable for multi-tenant.

### 2. A thin `fetch` client over Web Crypto, not Octokit

We implement a small `GitHubClient` adapter over `fetch` + `crypto.subtle` rather
than adopting Octokit / `@octokit/auth-app`.

- `@octokit/auth-app` has historically depended on Node `crypto` and pulls JWT
  dependencies that add bundle weight; the Workers runtime already provides RS256
  signing and HMAC via `crypto.subtle`.
- The repo's house style is small purpose-built adapters over Web Crypto (see
  `infrastructure/runtime.ts`).
- We only need a narrow API surface (installation discovery, repo/PR/issue/commit/
  check reads, and Git Data API writes), which a hand-rolled, fakeable client covers
  with a clean port boundary.

**Consequence:** the App private key **must** be PKCS#8 (`BEGIN PRIVATE KEY`).
GitHub issues PKCS#1; operators convert it once with `openssl pkcs8` (see
operations doc). We validate and fail loudly at key-import time.

### 3. Cache installation tokens in D1, not KV / a Durable Object

The `github_installations` row already binds installation → workspace and is read on
every webhook/sync, so it also stores the short-lived (~1h) installation token and
its expiry. This avoids a second binding (no new KV namespace) and avoids DO
complexity. Tokens are treated as expired ~5 min early; a lost cache is harmless
because a fresh token is cheaply re-minted from the app JWT, and concurrent minting
is safe (last-writer-wins; both tokens are valid).

### 4. Fast-ack webhooks → queue → projection; Workflow for backfills; cron reconcile

The webhook endpoint verifies the HMAC over the **raw** body, acks fast (`202`), and
enqueues the delivery on a Cloudflare Queue for asynchronous projection. Heavy
full-repo backfills run in a durable `GitHubBackfillWorkflow`. The existing cron
sweeper also reconciles stale projections, catching missed webhooks. When no queue
is bound (local/tests) the worker applies work inline.

### 5. Opt-in module

All GitHub core dependencies are optional in `CoreDependencies`; `createCore`
assembles the `github` module only when they're all present, and the worker wires
them only when `GITHUB_APP_ID` + secrets are set. This mirrors the existing
`AGENTS_ENABLED` / `EXECUTION_MODE` default-off convention, so the existing system
and tests are unaffected when GitHub is unconfigured.

## Consequences

- New D1 tables (migration `0004`), new core ports/services, new worker adapters and
  two controllers, a new (commented-out, opt-in) queue, and a new Workflow binding.
- The single Worker `queue` handler now multiplexes two queues, discriminating by
  `batch.queue`; the execution-queue guard was moved inside its own branch so a
  GitHub-only deployment works.
- Projections are eventually consistent; the source of truth remains GitHub. Reads
  are served from D1 (fast, rate-limit-free) and may briefly lag a write until the
  webhook/resync lands.
