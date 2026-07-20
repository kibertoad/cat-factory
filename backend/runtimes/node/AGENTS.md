# `@cat-factory/node-server` — Node.js runtime facade

> Directory `backend/runtimes/node`, published as `@cat-factory/node-server`.

One of **three runtime facades** serving the same `@cat-factory/server` Hono app — keep them
**symmetric** (`CLAUDE.md` → "Keep the runtimes symmetric"). Node differentiators:
**Drizzle/Postgres** persistence, **pg-boss** durable execution, a raw-WebSocket real-time
transport, and Node model provisioning.

**Entry:** `src/index.ts` (exports `start()` / `createServer()` / `buildNodeContainer`);
`src/main.ts` (runnable entrypoint); `src/server.ts`.

**Where things live:**

- `repositories/drizzle.ts` — the Drizzle repos implementing the kernel ports (the **twin** of
  the CF D1 repos; a 3.9k-line monolith slated for splitting — see
  `docs/refactoring-candidates.md` #1).
- `db/schema.ts` + `drizzle/` (generated migrations) — the Postgres schema; `migrate()`
  (`db/migrate.ts`) bootstraps it idempotently on boot, failing fast with an actionable error on
  a ledger↔schema desync and wrapping apply failures with a recovery hint. `scripts/db-reset.mjs`
  (`pnpm db:reset`) is the destructive clean-slate recovery. Schemas are configurable for a shared
  database via `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` / `DB_PGBOSS_SCHEMA` (see CLAUDE.md →
  "Migration safety").
- `container.ts` — the DI composition root (`buildNodeContainer`, with injected
  `resolveTransport`/`mintInstallationToken`/`githubClient` seams the local facade overrides).
  Cohesive slices of the composition root live in sibling `container-*-deps.ts` modules so the
  root stays within the file-size budget (the public seams stay exported from `container.ts`):
  `container-executor-deps.ts` (transport resolver, provisioning-log wrapper, container executor +
  env-config repairer, GitHub-issue filer, trace-sink builder), `container-github-deps.ts`
  (`selectNodeGitHubDeps` — the engine GitHub client + CI/mergeability/review/doc-quality gate
  wiring + task-source + issue-writeback + GitHub projection/sync module deps),
  `container-model-deps.ts` (credential/token stores + the model-provider resolver + inline
  executor), `container-run-services-deps.ts` (agent-observability + web-search + sealed-secret
  services), `container-transport-deps.ts` (runner transport + deploy seams + repo bootstrapper),
  `container-account-deps.ts` (per-account settings + binary-artifact storage +
  observability/incident gate wiring), `container-realtime-deps.ts` (event publisher +
  notification channel + consensus wrap), and `container-content-library-deps.ts`.
- `execution/` — pg-boss durable execution (`pgBossRunner`, `drive`).
- `gateways.ts`, `modelProvider.ts`, `realtime.ts`, `config.ts`, `retention.ts` — Node gateway
  - model + transport wiring and the retention sweep.

**See also:** `CLAUDE.md` → "Multi-runtime facades", "Resolving conflicting Drizzle migrations
(post-merge)".
