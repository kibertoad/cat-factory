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
  bootstraps it idempotently on boot.
- `container.ts` — the DI composition root (`buildNodeContainer`, with injected
  `resolveTransport`/`mintInstallationToken`/`githubClient` seams the local facade overrides).
- `execution/` — pg-boss durable execution (`pgBossRunner`, `drive`).
- `gateways.ts`, `modelProvider.ts`, `realtime.ts`, `config.ts`, `retention.ts` — Node gateway,
  model, and transport wiring plus the retention sweep.

**See also:** `CLAUDE.md` → "Multi-runtime facades", "Resolving conflicting Drizzle migrations
(post-merge)".
