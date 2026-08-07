# deploy/backend: example Cloudflare Worker deployment

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

Nothing else changes: `src/index.ts` and `wrangler.toml` stay identical.

## Registering your own extensions

The bare re-export above is the shape for a deployment that extends nothing. To register your own
agent kinds, gates, pipelines, task types or **foundational services** (your org's shared-capability
catalog: [ADR 0031](../../backend/docs/adr/0031-foundational-services.md)), swap the `default`
re-export for one line, keeping the class re-exports as they are:

```ts
import { createWorker, defaultFoundationalServiceRegistry } from '@cat-factory/worker'

const foundationalServiceRegistry = defaultFoundationalServiceRegistry()
foundationalServiceRegistry.registerAll(MY_ESTATE)

export default createWorker({ overrides: { foundationalServiceRegistry } })
```

`createWorker` owns everything the default export owns (the log-level read, boot-time validation
of _your_ registrations, and the `scheduled`/`queue` handlers) so there is nothing to reassemble
and a handler added upstream later reaches you without a change here. It is the Cloudflare
counterpart of `start({ … })` / `startLocal({ … })` on the Node and local facades.

## Configure

Edit `wrangler.toml`. Everything deployment-specific in it ships as a
`REPLACE_WITH_*` placeholder or an `example.com` hostname, so a copy you have not
finished configuring fails the deploy instead of pointing at a stranger's account:

- `name`, `[[d1_databases]].database_id`: your Worker name + D1 id
  (`wrangler d1 create cat_factory`).
- The second `[[d1_databases]]` entry (`binding = "TELEMETRY_DB"`): the **required**
  dedicated telemetry database. Provision it with
  `wrangler d1 create cat_factory_telemetry` and paste its id. Telemetry
  (`llm_call_metrics`, `agent_context_snapshots`) is append-heavy/short-retention, so it
  is kept off the main DB; its schema ships under
  `node_modules/@cat-factory/worker/telemetry-migrations`.
- `[[containers]].image`: the published runner image. Pin a version:
  `ghcr.io/<owner>/cat-factory-executor:<version>` (see the repo's
  `docker-publish` workflow; forks publish under their own owner).
- `[vars]`: `WORKER_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`, auth/GitHub ids, spend
  budget, and the per-feature toggles. Each block documents what it needs.
- Secrets: set with `wrangler secret put NAME` (never commit them); see
  `.dev.vars.example` for the local-dev equivalents.

The D1 schema migrations ship **with the library**; `migrations_dir` points at
`node_modules/@cat-factory/worker/migrations`. If your tooling can't read through
the pnpm symlink, copy them locally and repoint `migrations_dir` (see the comment
in `wrangler.toml`).

## Choosing the default model preset

Every workspace's model-preset library is seeded on first use with three built-ins
(Kimi K2.7, GLM-5.2, Claude Opus 5); the Worker marks **Kimi K2.7** the default (it runs
on the bare Cloudflare AI binding). The library API already accepts an override: the app
builder reads `defaultModelPresetId` off `createApp`'s `overrides`
(a `Partial<CoreDependencies>`):

```ts
import { createApp } from '@cat-factory/worker/app'
import { MODEL_PRESET_SEED_IDS } from '@cat-factory/worker'

const app = createApp({ overrides: { defaultModelPresetId: MODEL_PRESET_SEED_IDS.claude } })
```

The catch is that this deployment's `src/index.ts` **re-exports the library's ready-made
`default` handler**, which is more than `fetch`: it also carries the `scheduled` cron
sweeper (durable-run re-drive, GitHub reconcile, retention, Kaizen) and the `queue`
consumer. So overriding the default here is not a one-line option: you have to author your
own entry that calls `createApp({ overrides })` for `fetch` **and** reproduces the
`scheduled` + `queue` handlers, or those background jobs silently stop. Use the library's
own [`backend/runtimes/cloudflare/src/index.ts`](../../backend/runtimes/cloudflare/src/index.ts)
as the template (it builds the app exactly this way and defines the full handler) and add
`defaultModelPresetId` to the `overrides` it already passes.

`MODEL_PRESET_SEED_IDS` (`.kimi` / `.glm` / `.claude`) is re-exported from the library, so
you don't need a direct `@cat-factory/kernel` import. The override applies only at the
**first** seed of a workspace, so a user's later manual default choice is always preserved.
Most deployments keep the stock one-line re-export and leave the default at Kimi.

## Run & deploy

```sh
cp .dev.vars.example .dev.vars     # local-only auth escape hatch
pnpm dev                            # `wrangler dev`

# deploy (apply migrations first so the schema is live before the new code)
pnpm db:migrate:remote              # wrangler d1 migrations apply cat_factory --remote
pnpm deploy                         # `wrangler deploy`
```

In a copied deployment `@cat-factory/worker` is the published package, which ships
its compiled `dist`, so `wrangler` bundles it with no build step. Inside this repo
the dependency is `workspace:*` and `dist` is gitignored, so run the deploy through
Turbo, which builds the library first via the `^build` edge:
`pnpm exec turbo run deploy --filter=@cat-factory/deploy-backend`.
