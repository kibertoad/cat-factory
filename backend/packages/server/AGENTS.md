# `@cat-factory/server` — runtime-neutral HTTP layer

The shared Hono app **every runtime facade serves** (no `@cloudflare/*` dep). Controllers
resolve everything from `c.get('container')` (a `ServerContainer` = the domain `Core` + config

- `agentRunRepository` + gateways).

**Entry:** `src/index.ts`; `src/app.ts` — `registerCoreControllers(app)`.

**Where things live:**

- `modules/*/…Controller.ts` — the ~48 Hono controllers, one dir per module.
- `agents/` — the **shared, runtime-neutral** agent-dispatch layer: `CompositeAgentExecutor`,
  `ContainerAgentExecutor`, `RunnerJobClient`, `ContainerRepoBootstrapper`, `ModelRouter`.
  ⚠️ The CF facade has **same-named** classes under `runtimes/cloudflare/src/infrastructure/ai/`
  — those are the runtime **wiring**; the ones here are the shared **abstraction** (see
  `docs/glossary.md` → shared-vs-facade).
- `auth/` — HMAC signing, GitHub OAuth helper, WS tickets (`wsTicket.ts`).
- `http/` — request helpers, the shared **auth + per-workspace RBAC gate** (`authGate.ts` +
  `workspaceAccess.ts`: `loadWorkspaceAccess`, the viewer write floor, and
  `requireWorkspacePermission` — the admin-tier controller middleware); `config/` — the `AppConfig`
  contract; `runtime/gateways.ts` — the gateway **interfaces** (real-time, GitHub ingest/backfill,
  LLM upstream, web-search upstream).
- `persistence/mappers.ts` — the dialect-agnostic row↔domain mappers shared by **both** stores.
- The **mothership-mode machine API** (`/internal/*`, machine-token authed, mounted on both
  facades — see `docs/initiatives/mothership-mode.md`): `persistence/rpc.ts` +
  `modules/persistence/` (the repository RPC + GitHub installation-token delegation),
  `events/machineEvents.ts` + `modules/events/EventsRelayController.ts` (real-time upstream
  publish), and `notifications/machineNotifications.ts` +
  `modules/notifications/NotificationRelayController.ts` (notification delivery through the org's
  external transports). Each pairs a mothership-side controller + `ServerContainer` seam with the
  client half a mothership-mode node consumes.
- `github/FetchGitHubClient.ts` — the GitHub client.

**See also:** `CLAUDE.md` → "Workspace RBAC enforcement", "Multi-runtime facades", "Conventions".
