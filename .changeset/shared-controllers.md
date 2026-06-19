---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Move the runtime-neutral HTTP controllers into `@cat-factory/server`. The 18
controllers that only use the DI container + request helpers (board, execution,
pipelines, workspaces, accounts, documents, tasks, environments, runners,
bootstrap, agent-runs, board-scan, requirements, notifications, merge presets,
models, prompt-fragments, fragment-library) now live in the shared package and are
mounted by a facade via `registerCoreControllers(app)`. The shared request context
(`ServerContainer`, `AppEnv`) and the auth middleware (`requireAuth`,
`verifySession`, `bearerToken`) move there too.

The Cloudflare Worker keeps only its runtime-coupled controllers — the LLM proxy
(Workers AI binding), the WebSocket event stream (Durable Object), the GitHub
webhook (Queue) and connect (Workflow), and the OAuth login flow — and mounts the
shared controllers. `createApp`/`buildContainer` keep their signatures; all 326
worker integration tests pass unchanged.
