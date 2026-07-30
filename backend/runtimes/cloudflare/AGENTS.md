# `@cat-factory/worker` — Cloudflare Worker runtime facade

> Directory `backend/runtimes/cloudflare`, **published as `@cat-factory/worker`** (the
> package name predates the `runtimes/` layout). This is the Cloudflare deployment target —
> if you're looking for "the worker", it's here.

One of **three runtime facades** that serve the same runtime-neutral `@cat-factory/server`
Hono app. Keep them **symmetric** — any shared behaviour added here must land in the Node +
local facades too (root `CLAUDE.md` → "Keep the runtimes symmetric"). This facade supplies the
Cloudflare differentiators: D1 persistence, Durable Objects (real-time + per-run Containers),
Cloudflare Workflows (durable execution), queues/cron, and the `workers-ai` binding.

**Entry:** `src/index.ts` (default fetch/scheduled/queue handler + the DO/Workflow classes);
`src/app.ts` (`createApp()` — a thin wrapper over `@cat-factory/server`).

**Where things live** (under `src/infrastructure/`):

- `repositories/` — the D1 (SQLite) repos implementing the kernel ports (the **twin** of the
  Node facade's Drizzle repos).
- `container.ts` — the DI composition root (`buildContainer`), with its size-budget splits
  beside it: `container-assembly.ts` (the `ServerContainer` assembly), `container-registries.ts`
  (app-owned registry resolution), `container-trace-sinks.ts` (external LLM-trace destinations),
  `container-model-resolver.ts` (the memoised inline `ModelProviderResolver` + the per-step
  workspace default), `container-executor-deps.ts` (runner-transport selection, the container
  executor, the inline/sandbox composite and the consensus wrap) and `container-vcs-identity.ts`
  (the multi-App GitHub registry + the repo-target resolvers several siblings share). The
  executor and vcs-identity modules never import the root back — what they need from it arrives
  through `WorkerExecutorDeps` — so the module graph stays one-way.
- `ai/`, `gateways/`, `github/` — the CF gateway impls (realtime, GitHub, LLM upstream) + the
  container agent-executor **wiring** (same class names as `@cat-factory/server`'s `agents/`;
  those are the shared abstraction, these are the runtime wiring — see `docs/glossary.md`).
- `durable-objects/`, `workflows/`, `containers/`, `runners/` — durable execution + real-time
  - per-run-container machinery.

Package root (not under `src/`): `migrations/` + `telemetry-migrations/` +
`sandbox-migrations/` + `migrations-provisioning/` — the D1 schema; the twin of the Node
facade's `drizzle/` + `db/schema.ts`.

**See also:** `CLAUDE.md` → "Multi-runtime facades & cross-runtime conformance", "Execution
flow", "Repo bootstrap flow".
