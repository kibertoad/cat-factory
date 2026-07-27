# `@cat-factory/server` — runtime-neutral HTTP layer

The shared Hono app **every runtime facade serves** (no `@cloudflare/*` dep). Controllers
resolve everything from `c.get('container')` (a `ServerContainer` = the domain `Core` + config

- `agentRunRepository` + gateways).

**Entry:** `src/index.ts`; `src/app.ts` — `registerCoreControllers(app)`.

**Where things live:**

- `modules/*/…Controller.ts` — the ~50 Hono controllers, one dir per module.
- `modules/publicApi/` — the key-authenticated `/api/v1` surface (NOT behind the session gate):
  `PublicApiController` (jobs/board/pipelines/notifications), `PublicDecisionController` (a run's
  parked human decisions — the headless clarification loop), `publicApiAuth.ts` (the shared bearer
  gate + `read ⊂ write ⊂ decide ⊂ admin` ladder), `publicApiAdmission.ts` (what an external
  caller may launch) and `publicApiPaging.ts` (the opaque keyset cursor codec every bounded list
  on the surface shares — `GET /jobs`, `GET /services/:id/tasks` — plus the coarse-status
  projection `mapStatus`, its derived inverse `internalStatusesFor`, and `jobSortKey`, the ONE
  definition of a run's sort key so a cursor can never name a different value than the query
  orders by). See
  `docs/initiatives/headless-clarification-loop.md` and
  `docs/initiatives/public-api-expansion.md`.
- `modules/tasks/TaskWebhookController.ts` + `webhooks/` — the three PUBLIC, session-gate-bypassing
  webhook receivers (`/github`, `/vcs/:provider`, `/webhooks/tasks/:source/:workspaceId`) and their
  shared body-limit + signature-rejection logging. Each verifies over the RAW body before parsing,
  acks fast, and hands off through a `gateways` seam. The tracker one is the odd shape: its
  workspace rides the PATH (a tracker delivery has no installation id to resolve one from) and its
  secret is per CONNECTION rather than per deployment. See
  `docs/initiatives/tracker-webhook-intake.md`.
- `agents/` — the **shared, runtime-neutral** agent-dispatch layer: `CompositeAgentExecutor`,
  `ContainerAgentExecutor`, `RunnerJobClient`, `ContainerRepoBootstrapper`, `ModelRouter`.
  ⚠️ The CF facade has **same-named** classes under `runtimes/cloudflare/src/infrastructure/ai/`
  — those are the runtime **wiring**; the ones here are the shared **abstraction** (see
  `docs/glossary.md` → shared-vs-facade).
- `auth/` — HMAC signing, GitHub OAuth helper, WS tickets (`wsTicket.ts`).
- `http/` — request helpers, the shared **auth + per-workspace RBAC gate** (`authGate.ts` +
  `workspaceAccess.ts`: `loadWorkspaceAccess`, the viewer write floor, and
  `requireWorkspacePermission` — the admin-tier controller middleware) and `optionalJsonBody`
  (mount it before a contract route whose body is ALL-optional: a declared `requestBodySchema`
  otherwise makes the transport require a body, which breaks body-less callers of a route that
  merely gained an optional field); `config/` — the `AppConfig`
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
- `github/FetchGitHubClient.ts` — the GitHub client. Its siblings implement the engine-facing
  VCS ports over whatever `GitHubClient` a facade wires as its ENGINE client (so GitLab
  deployments get them too): `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
  `GitHubPullRequestMerger`, `GitHubBranchUpdater`, and `GitHubPrReportPublisher` (upserts the
  verification report as a marker-delimited region of the PR description).

**See also:** `CLAUDE.md` → "Workspace RBAC enforcement", "Multi-runtime facades", "Conventions".
