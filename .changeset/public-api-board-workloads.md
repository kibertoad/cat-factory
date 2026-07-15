---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Expose basic board workloads on the external public API (`/api/v1`), and generate an OpenAPI 3
spec for that surface.

New key-authenticated endpoints, each scoped to the key's workspace:

- `GET /api/v1/services` — list the workspace's services.
- `POST /api/v1/services/:serviceId/tasks` — create a task under a service.
- `GET /api/v1/services/:serviceId/tasks` — list a service's tasks.
- `GET /api/v1/tasks/:taskId` — get a task's status.
- `POST /api/v1/tasks/:taskId/start` — start (run) a task. Refused for a task on a subscription-only
  individual-usage model (no headless personal-credential unlock), or one whose enclosing service is
  archived (`409 service_archived` — an archived service's tasks stay readable but not start-able).
  The response re-reads the task after start, so it reflects the run's authoritative status.

Reads project a `Block` onto small `publicTask` / `publicService` resources — board/engine
internals are never leaked. Added on `BoardService`: `listServices`, `addServiceTask`,
`getServiceTask`, `listServiceTasks` (no new repository ports or migrations — both runtimes get
the behaviour through the shared server + orchestration layers).

Also adds a generated `docs/openapi.json` (OpenAPI 3.1) for the whole `/api/v1` surface, produced
from the Valibot contracts (`pnpm gen:openapi`) and guarded against drift in CI (`pnpm check:openapi`).
