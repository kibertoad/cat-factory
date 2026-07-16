---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
---

Grow the external public API (`/api/v1`) into a complete task-lifecycle surface: edit a task
(`PATCH /tasks/:taskId`), stop (`POST /tasks/:taskId/stop`) and retry (`POST /tasks/:taskId/retry`)
its run, read a rich run projection with per-step status/subtasks/failure/PR branch
(`GET /tasks/:taskId/run`), stream it live over SSE (`GET /tasks/:taskId/events`), and discover
startable pipelines (`GET /pipelines`). Each is key-authenticated, double-scoped to the key's
workspace and to real board tasks, and delegates to the existing service methods; retry reuses the
individual-usage-model refusal. The OpenAPI spec (`docs/openapi.json`) is regenerated to cover them.
