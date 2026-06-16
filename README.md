# cat-factory

Software development agent management platform

## Documentation

High-level docs (most live under [`backend/docs/`](./backend/docs)):

- **[Backend overview](./backend/README.md)** — the Cloudflare Workers + D1
  monorepo, its hexagonal layering, and how the pieces fit together.
- **[Authentication](./backend/docs/auth.md)** — "Login with GitHub"; GitHub
  accounts are the identity provider, so there's no separate user store.
- **Accounts & workspaces** — a signed-in user can switch between **accounts** (a
  personal account, plus any **orgs** they're a member of). An account owns many
  **workspaces** (boards), so a team of engineers shares the same org boards while
  keeping personal ones separate. Visibility is by membership; switching account
  re-scopes the board list (see the sidebar's board switcher).
- **GitHub integration** — connect an **account** to GitHub via a **GitHub App**
  (works with a personal account or an org) for repo/PR/issue read & write plus
  webhooks. The installation is shared across the account's workspaces, and each
  workspace then **explicitly links the specific repos** it tracks.
  [Design](./backend/docs/github-integration.md) ·
  [Setup runbook](./backend/docs/github-operations.md) ·
  [App Manifest](./backend/docs/github-app-manifest.html). Self-hosted, so each
  deployment registers its own App.
- **[Document sources](./backend/docs/document-sources.md)** — link requirements,
  RFCs and PRDs from external sources to a board and expand them into structure.
- **[Ephemeral environments](./backend/docs/environments-integration.md)** — plug
  in your own preview-environment tooling via a declarative HTTP manifest so
  `deployer`/`tester` agents can provision and run against it.
- **[Storage & retention](./backend/docs/storage-and-retention.md)** — the D1 data
  model's retention sweeps and follow-ups.
- **[Implementer harness](./backend/packages/implementer-harness/README.md)** — the
  payload that runs inside a per-run Cloudflare Container to do real code changes.
- **[Architecture & flow notes](./CLAUDE.md)** — the cross-cutting runtime flows
  (execution + real-time events, the repo-bootstrap flow and its known gaps, and
  the board/service/repo-linkage model) gathered in one place for quick lookup.

### Architecture decisions

- [ADR 0001 — GitHub integration via a GitHub App](./backend/docs/adr/0001-github-app-integration.md)
- [ADR 0002 — Cloudflare as the runtime platform](./backend/docs/adr/0002-cloudflare-platform.md)
- [ADR 0003 — Pluggable ephemeral-environment providers](./backend/docs/adr/0003-ephemeral-environment-provider.md)

## Deployment

Both halves deploy to Cloudflare under the `iselwin@gmail.com` account
(`wrangler whoami` must show account `fe0047c6e869c8cb875ca425a9c341af`). Each
has its own `wrangler.toml`: the backend Worker in
[`backend/packages/worker/`](./backend/packages/worker/wrangler.toml) and the
frontend Pages project at the [repo root](./wrangler.toml).

| Piece    | Cloudflare resource                | Production URL                      |
| -------- | ---------------------------------- | ----------------------------------- |
| Backend  | Worker `cat-factory-backend`       | `https://catfactory-api.kiberion.com` |
| Frontend | Pages project `cat-factory`        | `https://catfactory.kiberion.com`     |
| Data     | D1 database `cat_factory`          | (bound to the Worker as `DB`)         |

**Deploy the backend first** so any schema the new frontend expects is already
live, then the frontend. Migrations run **before** the Worker deploy.

### Backend (Worker + D1)

```sh
cd backend/packages/worker

# 1. apply any new migrations to the PRODUCTION D1 (review the pending list first)
wrangler d1 migrations list  cat_factory --remote
wrangler d1 migrations apply cat_factory --remote     # == pnpm db:migrate:remote

# 2. deploy the Worker (also rolls the container image, workflows, cron triggers)
wrangler deploy                                        # == pnpm --filter @cat-factory/worker deploy
```

The Worker prints its `*.workers.dev` URL; production traffic reaches it through
the `catfactory-api.kiberion.com` custom domain (configured in the Cloudflare
dashboard, not in `wrangler.toml`). First-time setup (auth, provider, GitHub-App
and container secrets) is in [`backend/README.md`](./backend/README.md#deploying)
— **auth is required or the API fails closed.**

### Frontend (Nuxt SPA → Pages)

The SPA is `ssr: false`, so the backend URL is **baked in at build time** from
`NUXT_PUBLIC_API_BASE` — it is *not* a Pages runtime var. Build with the prod
API base, then deploy the static output:

```sh
# from the repo root
NUXT_PUBLIC_API_BASE=https://catfactory-api.kiberion.com pnpm generate
wrangler pages deploy                  # project + output dir come from ./wrangler.toml
```

PowerShell equivalent for the build step:

```powershell
$env:NUXT_PUBLIC_API_BASE = "https://catfactory-api.kiberion.com"; pnpm generate
```

`pnpm generate` writes the static site to `.output/public`; `wrangler pages
deploy` (no args) reads the project name `cat-factory` and that output dir from
`./wrangler.toml`. `main` is the Pages **production** branch, so the deploy
updates the `catfactory.kiberion.com` alias. Sanity-check after deploying:

```sh
curl -s https://catfactory-api.kiberion.com/health        # {"status":"ok"}
curl -s https://catfactory.kiberion.com | grep -o catfactory-api.kiberion.com   # baked API base
```

### Emergency takedown

[`backend/scripts/teardown-production.sh`](./backend/scripts/teardown-production.sh)
deletes the Worker (and its containers/workflows/crons), optionally the Pages
project (`--include-pages`), and **always preserves** the D1 data.
Re-deploying brings production back.
