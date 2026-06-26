# deploy/backend — example Cloudflare Worker deployment

This package is the **deployment** half of the backend. The reusable logic lives
in the published [`@cat-factory/worker`](../../backend/runtimes/cloudflare) library
(plus `@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/orchestration`
and the other domain packages); this package carries only the
**configuration**: a `wrangler.toml`, the per-deployment `[vars]`, secrets
guidance, and a one-line entry (`src/index.ts`) that re-exports the library's
handler and Durable Object / Workflow classes.

Use it as a template: copy this directory into your own repo (or fork this one),
point the config at your Cloudflare resources, and deploy.

## How it depends on the library

In this monorepo the dependency is `workspace:*`, so it always builds against the
local source. **In your own deployment, depend on the published npm version**
instead:

```jsonc
// deploy/backend/package.json
"dependencies": {
  "@cat-factory/worker": "^0.6.0"   // instead of "workspace:*"
}
```

Nothing else changes — `src/index.ts` and `wrangler.toml` stay identical.

## Configure

Edit `wrangler.toml`:

- `name`, `[[d1_databases]].database_id` — your Worker name + D1 id
  (`wrangler d1 create cat_factory`).
- The second `[[d1_databases]]` entry (`binding = "TELEMETRY_DB"`) — the **required**
  dedicated telemetry database. Provision it with
  `wrangler d1 create cat_factory_telemetry` and paste its id. Telemetry
  (`llm_call_metrics`, `agent_context_snapshots`) is append-heavy/short-retention, so it
  is kept off the main DB; its schema ships under
  `node_modules/@cat-factory/worker/telemetry-migrations`.
- `[[containers]].image` — the published runner image. Pin a version:
  `ghcr.io/<owner>/cat-factory-executor:<version>` (see the repo's
  `docker-publish` workflow; forks publish under their own owner).
- `[vars]` — `WORKER_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`, auth/GitHub ids, spend
  budget, and the per-feature toggles. Each block documents what it needs.
- Secrets — set with `wrangler secret put NAME` (never commit them); see
  `.dev.vars.example` for the local-dev equivalents.

The D1 schema migrations ship **with the library**; `migrations_dir` points at
`node_modules/@cat-factory/worker/migrations`. If your tooling can't read through
the pnpm symlink, copy them locally and repoint `migrations_dir` (see the comment
in `wrangler.toml`).

## Run & deploy

```sh
cp .dev.vars.example .dev.vars     # local-only auth escape hatch
pnpm dev                            # builds the library, then `wrangler dev`

# deploy (apply migrations first so the schema is live before the new code)
pnpm db:migrate:remote              # wrangler d1 migrations apply cat_factory --remote
pnpm deploy                         # builds the library, then `wrangler deploy`
```

`predev`/`predeploy` build `@cat-factory/worker` first so `wrangler` bundles the
compiled `dist`.
