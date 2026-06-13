# Agent Architecture Board — Backend

Backend for the `cat-factory` frontend. Split into a **framework-agnostic core**
and a **Cloudflare Worker facade**, as separate packages, following the
infrastructure/domain layering and module grouping of `node-service-template`.

## Packages

| Package                  | Role                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `@cat-factory/contracts` | Valibot wire contract (entities + request bodies). Shared by the frontend and the backend.   |
| `@cat-factory/core`      | Domain layer: module services, pure logic, ports. No framework, no Cloudflare, no LLM SDK.   |
| `@cat-factory/worker`    | Infrastructure + API layer: Hono controllers, D1 repositories, composition root, the Worker. |

### Layering (per the template's architecture doc)

- **API layer** — `worker/src/modules/*/?*Controller.ts` (Hono routes), grouped by module.
- **Domain layer** — `core/src/modules/*` services + `core/src/domain` models/logic. Defines
  repository **ports**; depends on no concrete adapter.
- **Infrastructure layer** — `worker/src/infrastructure/*`: D1 repositories implementing the
  ports, the AI model provider, runtime adapters, config, and the DI composition root
  (`container.ts`). Services use constructor injection of a single `dependencies` object.

## Agents (Vercel AI SDK)

Each pipeline step is performed by an `AgentExecutor` (a port). Implementations:

- **`AiAgentExecutor`** (core) — real work through the Vercel AI SDK (`generateText`). The model
  is chosen per agent kind via `AgentRouting` ("which LLM, with what config, for what"),
  configured from Worker env vars (`AGENT_DEFAULT_PROVIDER/MODEL`, `AGENT_MODELS` JSON overrides).
  Concrete models are resolved by `CloudflareModelProvider` (OpenAI / Anthropic / Workers AI).
- **`SimulatorAgentExecutor`** (core) — the playful, randomised experience the frontend prototype
  used to hardcode (occasional human decisions, random confidence). Used for **local / mock
  runtime only**, never in tests.
- **`FakeAgentExecutor`** (worker tests) — deterministic; used by the integration tests.

The engine itself (`ExecutionService`) is deterministic and contains no randomness: a `tick`
advances each running pipeline by one agent-performed step.

## HTTP API (selected)

```
POST   /workspaces                                            create board (optionally seeded)
GET    /workspaces                                            list boards
GET    /workspaces/:ws                                        full snapshot (blocks, pipelines, executions)
DELETE /workspaces/:ws

POST   /workspaces/:ws/blocks                                 add frame
POST   /workspaces/:ws/blocks/:id/tasks                       add task
POST   /workspaces/:ws/blocks/:id/modules                     add module
PATCH  /workspaces/:ws/blocks/:id                             update
POST   /workspaces/:ws/blocks/:id/move                        move
POST   /workspaces/:ws/blocks/:id/reparent                   move into a container
POST   /workspaces/:ws/blocks/:id/dependencies               toggle a dependency edge
DELETE /workspaces/:ws/blocks/:id                             delete (cascades)

GET    /workspaces/:ws/pipelines
POST   /workspaces/:ws/pipelines
DELETE /workspaces/:ws/pipelines/:id

POST   /workspaces/:ws/blocks/:id/executions                 start a pipeline run
DELETE /workspaces/:ws/blocks/:id/executions                 cancel
POST   /workspaces/:ws/blocks/:id/merge                       merge an open PR
POST   /workspaces/:ws/tick                                   advance the simulation { ticks }
POST   /workspaces/:ws/executions/:exec/decisions/:dec        resolve a human decision
```

## Develop & test

```bash
pnpm install

# run the Worker locally (applies migrations to a local D1 on first request)
pnpm --filter @cat-factory/worker db:migrate:local
pnpm dev

# integration tests — real workerd + real local D1 (no mocking of infra)
pnpm test
```

Integration tests run via `@cloudflare/vitest-pool-workers` inside the same runtime Wrangler uses,
against a real local D1 database with the real migrations applied. Only the LLM is faked
(deterministically); the storage and HTTP stack are real.

### Deploying

Set a real `database_id` in `wrangler.toml` (`wrangler d1 create cat_factory`), apply migrations
with `db:migrate:remote`, set provider secrets (`wrangler secret put OPENAI_API_KEY`), flip
`AGENTS_ENABLED=true`, and `pnpm deploy`.
