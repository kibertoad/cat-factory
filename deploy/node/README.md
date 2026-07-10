# deploy/node — example Node.js service deployment

This package is the **deployment** half of the backend for the **Node.js** runtime.
The reusable logic lives in the published
[`@cat-factory/node-server`](../../backend/runtimes/node) library (plus
`@cat-factory/server`, `@cat-factory/kernel`, `@cat-factory/orchestration` and the
other domain packages); this package carries only the **configuration**: a
`Dockerfile`, an `.env.example`, and a one-line entry (`src/main.ts`) that calls the
library's `start()`.

It is the Postgres + pg-boss counterpart to [`deploy/backend`](../backend) (the
Cloudflare Worker). Both serve the same HTTP API from the shared `@cat-factory/server`
app — pick the runtime that fits your infrastructure.

Use it as a template: copy this directory into your own repo (or fork this one),
point the env at your Postgres, and run it (bare Node or the Docker image).

## How it depends on the library

In this monorepo the dependency is `workspace:*`, so it always builds against the
local source. **In your own deployment, depend on the published npm version**
instead:

```jsonc
// deploy/node/package.json
"dependencies": {
  "@cat-factory/node-server": "^0.6.0"   // instead of "workspace:*"
}
```

Nothing else changes — `src/main.ts` and the env contract stay identical.

## Requirements

- **Node.js 24 or 26.** The entry (`src/main.ts`) is run directly via Node's built-in
  TypeScript **type stripping** — there is no build step for this package (the library
  itself ships compiled `dist`).
- **Postgres** (any reachable instance). The server runs its schema migration on boot,
  so an empty database is fine.

## Configure

Configuration is entirely environment-driven. The `dev`/`start` scripts load a local
`.env` with Node's **native** `--env-file-if-exists` flag (no dotenv dependency); in
production, inject the same variables through your orchestrator.

```sh
cp .env.example .env     # then edit DATABASE_URL etc.
```

`DATABASE_URL` is the only required variable. The rest (auth, model-provider keys,
spend budget, execution tuning) are documented inline in `.env.example`. As with the
Worker, the auth gate **fails closed**: set the OAuth/session secrets for real auth, or
`AUTH_DEV_OPEN=true` (non-production only) to run open while developing.

## Recovering a wedged database (`db:reset`)

The server validates its migration state on boot: if the migration ledger records applied
migrations but the tables they created are missing, boot **fails fast** with an actionable
message rather than dying with an opaque Postgres error deep inside a migration. The usual
cause is the drizzle-kit 1.0 ledger↔schema split — the migrator's `__drizzle_migrations`
ledger lives in its own `drizzle` schema, so a hand `DROP SCHEMA public CASCADE` (or a stray
test run against this database) wipes the tables while the ledger keeps claiming everything
is applied.

To recover, reset the database to a clean slate and let the next boot re-migrate from
scratch. This **permanently deletes all data** in `DATABASE_URL`:

```sh
pnpm --filter @cat-factory/node-server db:reset   # DROPS ALL DATA in DATABASE_URL, then re-migrates on next start
pnpm start
```

`db:reset` drops **all** app-owned schemas together — `public`, `telemetry`, `sandbox`,
`provisioning`, the `drizzle` ledger, and pg-boss's `pgboss` schema — so the ledger can never
outlive the data it tracks. **Do NOT** hand-drop `public` alone: that is what causes the
split in the first place.

> **D1 / Cloudflare Worker:** the Worker facade has no boot-time drizzle migrator (D1
> migrations are applied by wrangler). To reset a **local** D1, drop the local state (delete
> the `deploy/backend/.wrangler` state dir, or `wrangler d1 execute <db> --local` a fresh
> schema) and re-apply migrations.

## Sharing a database with other services

By default cat-factory owns the `public` (app tables), `drizzle` (migration ledger), `pgboss`,
`telemetry`, `sandbox`, and `provisioning` schemas of its database. If you must run it on a
database shared with other services, three schema names are configurable so cat-factory can't
collide with a schema another service owns (each must be a plain identifier):

| Env                    | Default   | What it moves                                                                                                                                                                          |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_SCHEMA`            | `public`  | The default app tables (relocated via the connection `search_path`). Set this when the database has no usable `public` schema.                                                         |
| `DB_MIGRATIONS_SCHEMA` | `drizzle` | The drizzle migration ledger (`__drizzle_migrations`). Set this so cat-factory's ledger can't collide with **another drizzle-using service's** default `drizzle.__drizzle_migrations`. |
| `DB_PGBOSS_SCHEMA`     | `pgboss`  | pg-boss's durable-job queue schema.                                                                                                                                                    |

The named app schemas (`telemetry` / `sandbox` / `provisioning`) are fixed and not configurable.
`db:reset` reads the same variables, so it drops exactly the schemas the deployment owns.

## Choosing the default model preset

Every workspace's model-preset library is seeded on first use with three built-ins
(Kimi K2.7, GLM-5.2, Claude Opus 4.8); the Node facade marks **Kimi K2.7** as the
default because it runs on the bare Cloudflare AI baseline. To ship a different
out-of-the-box default, pass `defaultModelPresetId` to `start()` — the entry (`src/main.ts`)
is yours to edit:

```ts
import { start, MODEL_PRESET_SEED_IDS } from '@cat-factory/node-server'

start({ defaultModelPresetId: MODEL_PRESET_SEED_IDS.claude }).catch((err: unknown) => {
  console.error('failed to start cat-factory node server:', err)
  process.exit(1)
})
```

`MODEL_PRESET_SEED_IDS` is re-exported from the library (`.kimi` / `.glm` / `.claude`), so
you don't need a direct `@cat-factory/kernel` import. This is a **deployment-level fact**
resolved at composition time, not an env var — the same programmatic seam as the
`agentKindRegistry` option. It applies only at the **first** seed of a workspace, so a
user's later manual default choice is always preserved; changing it does not retroactively
re-flag existing workspaces (they can reseed from the UI).

## Run

```sh
# Local (bare Node): builds the library, then runs the service with .env loaded.
pnpm dev        # node --watch --env-file-if-exists=.env src/main.ts
pnpm start      # one-shot

# From the repo root:
pnpm dev:node
```

## Docker

The `Dockerfile` builds from the **repo root** (its context is the whole workspace):

```sh
# from the repo root
docker build -f deploy/node/Dockerfile -t cat-factory-node .
docker run --rm -p 8787:8787 --env-file deploy/node/.env cat-factory-node
```

It installs the workspace, runs `pnpm build`, then re-resolves to **production-only**
dependencies in place (`pnpm install --prod`, dropping dev tooling) and prunes the
store — no `pnpm deploy`/`--legacy`. The slim runtime then runs `src/main.ts` directly
via Node's type stripping.
