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
  "@cat-factory/node-server": "^0.1.0"   // instead of "workspace:*"
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

It is a two-stage build: stage one installs the workspace, runs `pnpm build`, and uses
`pnpm deploy --prod` to emit a self-contained app with only this package and its
production dependencies; stage two is a slim runtime that runs `src/main.ts` directly.
