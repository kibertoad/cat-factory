# GitHub Integration

cat-factory connects each **workspace** (architecture board) to a GitHub
organization or account so its agents and blocks can operate on real code:
**read** repos/branches, pull requests/issues, commits and CI checks; **write**
branches, commits, pull requests and comments; and keep a **local projection** of
the data it reads often, resynced from **webhooks**, an **on-demand** endpoint, and
a periodic **reconciliation** pass.

This document explains the access model, the architecture, the data flow, and the
projection/resync model. For setup and operations (creating the App, secrets, key
conversion, troubleshooting) see [github-operations.md](./github-operations.md).
For the design rationale see [adr/0001-github-app-integration.md](./adr/0001-github-app-integration.md).

---

## Why a GitHub App (and not OAuth / PAT)

| Option                       | Identity / isolation                                             | Webhooks             | Rate limits            | Verdict                             |
| ---------------------------- | ---------------------------------------------------------------- | -------------------- | ---------------------- | ----------------------------------- |
| **GitHub App** (chosen)      | Per-**installation** tokens → one credential scope per workspace | Built in, one secret | Scale per installation | ✅ Multi-tenant read/write/webhooks |
| OAuth App                    | User-scoped tokens; no per-install isolation                     | Configured per repo  | Per user               | ✖ No clean tenant isolation         |
| PAT (classic / fine-grained) | Single user; manual rotation                                     | None                 | Per user               | ✖ Not multi-tenant                  |

A GitHub App is the only model that cleanly satisfies all three requirements at
once: **multi-tenant**, **read + write**, and **webhooks**. Each cat-factory
workspace maps to exactly one App **installation**, which gives per-workspace
credential isolation (a short-lived installation token), fine-grained repository
permissions, native webhook delivery, and rate limits that scale with the number
of installations.

---

## Architecture

The integration follows the existing hexagonal layering — `contracts` (wire
schemas) → `core` (ports + services) → `worker` (adapters + HTTP). It is **opt-in**:
the core `github` module is assembled only when all its dependencies are present,
which the worker wires only when a GitHub App is configured (`GITHUB_APP_ID` +
secrets). With it unconfigured, nothing about the existing system changes.

```
                  ┌─────────────────────────── worker (Cloudflare) ───────────────────────────┐
   GitHub  ──webhook──▶ POST /github/webhooks ──verify HMAC──▶ enqueue ──▶ GITHUB_SYNC_QUEUE
                          (fast 202 ack)                                         │
   browser ──install──▶ GET  /github/setup/callback ──verify state──▶ bind        │ consumer
                                                                                  ▼
   app ─────────────▶ /workspaces/:id/github/* ──▶ GitHubService ───────▶  WebhookService /
                       (reads from D1, writes via client)                   GitHubSyncService
                                                          │                        │
                                       FetchGitHubClient ─┘   (App auth, rate limit) │
                                                          ▼                          ▼
                                                 api.github.com           D1 projection tables
                                                                          (repos, branches, PRs,
                                                                           issues, commits, checks)
   cron (*/2) ──▶ reconcileStaleRepos ──▶ enqueue resync of stale repos
   Workflow   ──▶ GitHubBackfillWorkflow ──▶ deep sync on connect / full resync
```

### Core ports (`backend/packages/core/src/ports`)

- **`GitHubClient`** (`github-client.ts`) — the narrow REST surface we use
  (installation discovery, reads, and writes incl. the Git Data API). Read methods
  return projection-shaped entities.
- **`*ProjectionRepository` + `GitHubInstallationRepository` + `RateLimitRepository`**
  (`github-repositories.ts`) — persistence ports for the projections, the
  workspace↔installation binding (with cached token), and the rate-limit ledger.
- **`WebhookVerifier`** (`webhook-verifier.ts`) — HMAC verification of deliveries.

### Core services (`backend/packages/core/src/modules/github`)

- **`GitHubInstallationService`** — connect/disconnect, the workspace↔installation
  binding, and `requireInstallation`.
- **`GitHubSyncService`** — the _pull_ side: fetch from `GitHubClient`, persist
  projections, advance per-repo cursors. Drives incremental resync and full backfill.
- **`WebhookService`** — the _push_ side: apply the resource embedded in a verified
  delivery directly to the projection (no extra API call) and handle install lifecycle.
- **`GitHubService`** — the read/write facade for the API controller (reads from D1;
  writes via `GitHubClient`, then opportunistically refresh the projection).
- **`projection.logic.ts`** — pure GitHub-JSON → projection-entity mappers, shared by
  the fetch client and the webhook consumer.

### Worker adapters (`backend/packages/worker/src/infrastructure/github`)

- **`GitHubAppAuth`** — RS256 app JWT + installation-token mint/cache, all on Web Crypto.
- **`FetchGitHubClient`** — the only code that calls `api.github.com`; auth,
  rate-limit accounting, conditional requests, pagination, Git Data API writes.
- **`WebCryptoWebhookVerifier`** — HMAC-SHA-256 verification.
- **`state.ts`** — HMAC-signed `state` for the connect flow (CSRF / binding guard).
- **`sync-consumer.ts`** — queue consumer + cron reconciliation orchestration.

---

## Authentication

All crypto uses the Workers-native Web Crypto API (`crypto.subtle`) — no Octokit,
no Node `crypto`.

- **App JWT (RS256)** authenticates as the App, to mint tokens and read
  installation metadata. The PKCS#8 private key is imported once with
  `importKey('pkcs8', …, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' })`; claims are
  `{ iat: now-60s, exp: now+9m, iss: appId }`.
- **Installation token** (`POST /app/installations/:id/access_tokens`, ~1h TTL) is
  cached in the `github_installations` row and reused until ~5 min before expiry; a
  cache miss simply re-mints.
- **Webhook signatures** are verified with HMAC-SHA-256 over the **raw** request
  body against `X-Hub-Signature-256`, before any JSON parsing.

---

## Connect flow

1. Frontend calls `GET /workspaces/:id/github/install-url` → we return the App
   install URL carrying an HMAC-signed `state` (the workspace id).
2. The user installs the App; GitHub redirects to
   `GET /github/setup/callback?installation_id=…&state=…`.
3. We verify `state` (binding/CSRF guard), then bind the installation to the
   workspace (`github_installations`).
4. We kick off an initial backfill: the `GitHubBackfillWorkflow` if bound, else an
   inline repo discovery that the cron pass then deepens.

A programmatic `POST /workspaces/:id/github/connect { installationId }` exists for
testing and headless setups. User-to-server OAuth is **not** needed — installation
tokens cover repo read/write.

---

## Projections & resync

cat-factory projects **repos & branches, pull requests & issues, and commits &
check-runs** into D1 (migration `0004_github_projections.sql`). It does **not**
cache file trees/contents. Projection rows are workspace-scoped, use `synced_at`
timestamps, and are soft-deleted via `deleted_at` tombstones so deletes and a later
full reconciliation converge without losing history.

Three resync mechanisms keep projections fresh:

1. **Webhook-driven (push)** — the primary path. `POST /github/webhooks` verifies the
   signature, acks fast (`202`), and enqueues the delivery; the consumer applies the
   embedded resource via `WebhookService` (no extra API call for the common events).
   Handled events: `pull_request`, `issues`, `push`, `check_run`, and the
   `installation` / `installation_repositories` lifecycle.
2. **On-demand (pull)** — `POST /workspaces/:id/github/resync`:
   incremental for the whole workspace, a single repo (`repoGithubId`), or a full
   durable backfill (`full: true` → `GitHubBackfillWorkflow`).
3. **Periodic reconciliation** — the existing `*/2 * * * *` cron also runs
   `reconcileStaleRepos`, enqueuing an incremental resync for any tracked repo whose
   projection is older than the staleness window (catches missed webhooks).

Incremental syncs use per-repo **cursors** (`github_sync_cursors`): ETags for
conditional `branches` GETs and `since` timestamps for `pulls`/`issues`/`commits`
delta listing.

> **Fast-ack contract:** the webhook endpoint verifies on the raw body and offloads
> all projection work to the queue, so GitHub is never blocked. When no queue is
> bound (local dev / tests) the worker applies the work inline as a fallback.

---

## HTTP endpoints

| Method                | Path                                                                                 | Purpose                                    |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `POST`                | `/github/webhooks`                                                                   | Verified webhook receiver (GitHub-facing)  |
| `GET`                 | `/github/setup/callback`                                                             | App install callback (browser-facing)      |
| `GET`                 | `/workspaces/:id/github/install-url`                                                 | Signed install URL                         |
| `GET`/`POST`/`DELETE` | `/workspaces/:id/github/connection` (+ `/connect`)                                   | Manage the binding                         |
| `POST`                | `/workspaces/:id/github/resync`                                                      | Trigger resync (incremental / repo / full) |
| `GET`                 | `/workspaces/:id/github/repos` · `…/repos/:repoId/branches` · `…/pulls` · `…/issues` | Projection reads                           |
| `POST`                | `…/repos/:repoId/branches` · `…/commits` · `…/pulls`                                 | Writes                                     |
| `PUT`                 | `…/repos/:repoId/pulls/:number/merge`                                                | Merge a PR                                 |
| `POST`                | `…/repos/:repoId/issues/:number/comments`                                            | Comment                                    |

All workspace-scoped endpoints return `503` when the integration is not configured.
