# `@cat-factory/server`: runtime-neutral HTTP layer

The shared Hono app **every runtime facade serves** (no `@cloudflare/*` dep). Controllers
resolve everything from `c.get('container')` (a `ServerContainer` = the domain `Core` + config

- `agentRunRepository` + gateways).

**Entry:** `src/index.ts`; `src/app.ts`: `registerCoreControllers(app)`.

**Where things live:**

- `modules/*/…Controller.ts`: the ~50 Hono controllers, one dir per module.
- `modules/publicApi/`: the key-authenticated `/api/v1` surface (NOT behind the session gate):
  `PublicApiController` (jobs/board/pipelines/notifications), `PublicDecisionController` (a run's
  parked human decisions; the headless clarification loop), `PublicDebugController` (the
  `read`-scoped remote **run debugging** reads over a run's telemetry + provisioning log, sized so
  an LLM can walk them within a context budget; see `docs/debug-api.md`), `publicApiAuth.ts` (the
  shared bearer gate + `read ⊂ write ⊂ decide ⊂ admin` ladder), `publicApiAdmission.ts` (what an external
  caller may launch: `parkSurfacesOf` reads the PIPELINE, and `publicRunParkSurfaces` composes in
  the pre-dispatch input gate, which parks on the shape of the TASK and so is invisible to the
  step chain) and `publicApiPaging.ts` (the opaque keyset cursor codec every bounded list
  on the surface shares (`GET /jobs`, `GET /services/:id/tasks`, every `/api/v1/debug/*` list) plus the coarse-status
  projection `mapStatus`, its derived inverse `internalStatusesFor`, and `jobSortKey`, the ONE
  definition of a run's sort key so a cursor can never name a different value than the query
  orders by). Two collaborators own the create's ORDERING, which is the whole design and does not
  read as such inlined between route registrations: `ticketLinkage.ts` (file a task FROM a tracker
  ticket: resolve and refuse before the block exists, claim after) and `documentAttachment.ts`
  (attach the requirements documents a task is built against, imported from a connected source or
  uploaded whole, with the task rolled back if an attachment does not land). See
  `docs/initiatives/headless-clarification-loop.md`,
  `docs/initiatives/public-api-additions.md` and
  `backend/docs/adr/0030-public-api-surface.md`.
- `modules/tasks/TaskWebhookController.ts` + `webhooks/`: the three PUBLIC, session-gate-bypassing
  webhook receivers (`/github`, `/vcs/:provider`, `/webhooks/tasks/:source/:workspaceId`) and their
  shared body-limit + signature-rejection logging. Each verifies over the RAW body before parsing,
  acks fast, and hands off through a `gateways` seam. The tracker one is the odd shape: its
  workspace rides the PATH (a tracker delivery has no installation id to resolve one from) and its
  secret is per CONNECTION rather than per deployment. See
  `backend/docs/adr/0032-tracker-webhook-intake.md`.
- `agents/`: the **shared, runtime-neutral** agent-dispatch layer: `CompositeAgentExecutor`,
  `ContainerAgentExecutor`, `RunnerJobClient`, `ContainerRepoBootstrapper`, `ModelRouter`.
  Two collaborators split out of the executor to keep it inside its (ratcheting-down) size
  budget: `containerAgentLogging.ts` (the workflow↔container seam's log vocabulary) and
  `agentContextRecord.ts` (the observability snapshot's ALLOW-LIST projection; the one place
  that decides what of a dispatch may be persisted, so a new body field is opt-in, never
  inherited). Every dispatcher of the `agent` kind (the executor, the bootstrapper and
  `ContainerEnvConfigRepairer`) puts `workspaceId`/`executionId` on its job body so the
  container's own log lines join to the backend's.
  `agents/providerCapabilities.ts` resolves what a workspace (+ its account + the user) has
  configured into kernel's `ProviderCapabilities`, the one join point the model catalog and the
  pipeline-start guard share; `agents/bedrock.ts` parses `BEDROCK_MODELS` for it and is the ONLY
  parse of that var, because the Bedrock resolver's own allow-list has to be the same list
  (parsed twice, the picker could offer an id the resolver throws on).
  `agents/promptOverrides.ts` is the container half of the per-workspace **agent prompt
  override**: `dispatchSystemPromptFor` is what every container prompt assembly rides (the
  inline + consensus executors pass the override to `systemPromptFor` directly), and
  `BESPOKE_CONTAINER_SYSTEM_PROMPTS` names the two kinds (`merger` / `on-call`) whose dispatch
  bypasses `systemPromptFor`. Each entry splits that kind's constant into the EDITABLE role half
  and the non-editable `directives` tail, so an override replaces the role while the tail is
  re-appended: the bespoke path's equivalent of `applySurfaceDirectives`.
  ⚠️ The CF facade has **same-named** classes under `runtimes/cloudflare/src/infrastructure/ai/`:
  those are the runtime **wiring**; the ones here are the shared **abstraction** (see
  `docs/glossary.md` → shared-vs-facade).
- `auth/`: HMAC signing, GitHub OAuth helper, WS tickets (`wsTicket.ts`).
- `http/errorHandler.ts`: the ONE `app.onError` both facades mount. A controller signals a
  refusal by THROWING a kernel `DomainError`; the handler maps its `code` to a status and emits
  `{ error: { code, message, details? } }`. **Do not hand-roll that envelope**: a literal
  `c.json({ error: { code: 'unavailable', … } }, 503)` structurally cannot carry the
  machine-readable `details.reason` the SPA maps to translated copy. The full vocabulary is
  `NotFoundError` (404) / `ValidationError` (422) / `ConflictError` (409) /
  `CredentialRequiredError` (428) / `ForbiddenError` (403) / `UnavailableError` (503) /
  `UnauthorizedError` (401) / `RateLimitedError` (429). A controller-local
  `const unavailable = (): never => { throw new UnavailableError(…) }` keeps the call sites
  reading `return unavailable()`, `never` is assignable to any declared response type.
  The one deliberate exception is a handler that flattens distinct causes ON PURPOSE because
  the distinction is an ORACLE (password reset: "no such token" vs "expired" vs "used").
  Every envelope also carries the request's `requestId` (see below).
- `http/requestLogging.ts`: `mountRequestLogging`, mounted **first** by both facades (before
  CORS and the per-request container). Mints/adopts `X-Request-Id`, binds a request-scoped child
  logger, echoes the id on the response + in every error envelope, and logs one line per request
  (`info`, 4xx `warn`, 5xx `error`). Reach the bound logger from a controller with
  `requestLogger(c)`. ⚠️ It deliberately does NOT set the header on a 101: Hono implements a
  post-`next()` `c.header()` by rebuilding the response, which drops Cloudflare's `webSocket`
  property and would break the SPA's live stream on the deployed runtime only.
  `createMisconfiguredApp` mounts it too: the Worker inherits it by serving the fallback from
  inside `createApp`, but Node/local swap in that whole app, so without its own mount the one
  deployment shape someone is actively debugging would be the only one with no ids.
- `http/`: request helpers, the shared **auth + per-workspace RBAC gate** (`authGate.ts` +
  `workspaceAccess.ts`: `loadWorkspaceAccess`, the viewer write floor, and
  `requireWorkspacePermission`; the admin-tier controller middleware) and `optionalJsonBody`
  (mount it before a contract route whose body is ALL-optional: a declared `requestBodySchema`
  otherwise makes the transport require a body, which breaks body-less callers of a route that
  merely gained an optional field); `config/` (the runtime-neutral env parsers both facades
  share; a rejected value is REPORTED through `config/warnOnce.ts`, once per process rather
  than once per read, because the Worker re-derives its whole config on every invocation);
  the `AppConfig`
  contract; `runtime/gateways.ts`; the gateway **interfaces** (real-time, GitHub ingest/backfill,
  LLM upstream, web-search upstream).
- `runtime/` also holds the **runtime-neutral periodic sweeps** each facade drives from its own
  scheduler (Worker cron ⇄ Node `setInterval`), so the behaviour cannot drift between them:
  `platformHealth.ts` (run-health threshold alerting), `keyDrift.ts`, and `infraReachability.ts`
  (probes each board's CONFIGURED infrastructure connections and reports a dead one as
  `unreachable`). A new sweep belongs here and is called from BOTH facades.
- `observability/logger.ts`: the **only place a logging library is named**: pino adapted onto the
  kernel `Logger` port, exported as the process-wide `logger` (plus `createPinoLogger` for a custom
  destination, and `parseLogLevel`/`setLogLevel`, which each facade applies from `LOG_LEVEL` at the
  top of its boot path). It also owns the SECOND-destination seam: `setLogSink` installs a kernel
  `LogSink` (the opt-in OTLP log exporter) that every emitted line is copied to, with the
  `child`-bound fields folded in and behind the same level gate. Patterns and rules:
  [`backend/docs/logging.md`](../../docs/logging.md).
- `persistence/mappers.ts`: the dialect-agnostic row↔domain mappers shared by **both** stores.
- `test/coverageScan.ts` + the `*.coverage.spec.ts` beside it: the guards for the rules a
  typecheck cannot hold, where a field must stay OPTIONAL because one caller is entitled to the
  default (`initiatedByRole`, `intakeOrigin`). Each classifies every call site and fails on a new
  one until someone writes down which bucket it is in. They read through `loadCode`, which strips
  comments first: a guard matching raw text is satisfied by a file that merely NAMES the literal
  it should pass, which is exactly how one stayed green over a call site missing its value.
- The **mothership-mode machine API** (`/internal/*`, machine-token authed, mounted on both
  facades: see `docs/initiatives/mothership-mode.md`): `persistence/rpc.ts` +
  `modules/persistence/` (the repository RPC + GitHub installation-token delegation),
  `events/machineEvents.ts` + `events/machineSubscribe.ts` +
  `modules/events/EventsRelayController.ts` (real-time in BOTH directions; the upstream publish
  and the node's inbound per-workspace subscription, whose handshake is handed to the SAME
  `gateways.realtime.upgrade` seam the browser stream uses), and `notifications/machineNotifications.ts` +
  `modules/notifications/NotificationRelayController.ts` (notification delivery through the org's
  external transports), and `telemetry/machineTelemetry.ts` +
  `modules/telemetry/TelemetryIngestController.ts` (the batch upload of a finished run's
  local-first telemetry; its own endpoint precisely because per-row remote writes are what the
  local-first bucket exists to prevent) beside `telemetry/machineTelemetryRead.ts` +
  `modules/telemetry/TelemetryReadController.ts` (that upload's DUAL: a closed, per-method-bounded
  table of run-scoped READS, so a node whose local store holds nothing for a run renders the
  mothership's copy instead of an empty panel). Each pairs a mothership-side controller +
  `ServerContainer` seam with the client half a mothership-mode node consumes: except the two
  telemetry endpoints, which need no seam: both go through the mothership's own `repositories`
  registry. Two more carry CODE-REGISTERED org state rather than rows, and pair a controller with
  a client half the node injects as a kernel SOURCE port instead of a container seam:
  `modules/foundationalServices/FoundationalBuiltinsController.ts` +
  `persistence/foundationalBuiltins.ts` (the catalog's `builtin` tier) and
  `modules/binaryGenerators/BinaryGeneratorsController.ts` + `persistence/binaryGenerators.ts`
  (the generative binary integrations). Both READ this process's own registry and THROW rather
  than answering empty: see each file's header for why the two dispositions then differ.
- `github/FetchGitHubClient.ts`: the GitHub client. Its siblings implement the engine-facing
  VCS ports over whatever `GitHubClient` a facade wires as its ENGINE client (so GitLab
  deployments get them too): `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
  `GitHubPullRequestMerger`, `GitHubBranchUpdater`, and `GitHubPrReportPublisher` (upserts the
  verification report as a marker-delimited region of the PR description).
  - The client is at a ratcheting size budget, so cohesive concerns live BESIDE it and it keeps a
    thin delegate. Each takes the client's bound `request` rather than the client itself, which is
    also what makes them testable without a client: `reviewPosting.ts` + `reviewThreads.ts` (the
    REST and GraphQL halves of PR review), `searchApi.ts`, `branchProtection.ts` (the
    security-preflight probe + the required-approvals lookup; together because they read the SAME
    resource and must not learn failure modes separately), `viewerTokenReads.ts` (the CALLER-token
    repo reads behind the personal-PAT picker; mints, caches and rate-limit-accounts nothing), and
    `githubHttpHelpers.ts` (`GitHubApiError` + the shared request constants).
  - `github/runInitiatorToken.ts` is the ONE answer to "does this run act with its initiator's own
    token, or the deployment credential?": asked by `PatPreferringAppRegistry` (the engine client)
    and by both facades' container-dispatch mints, so an opted-out workspace cannot be honoured on
    one path and missed on another. It reads the two-tier `allowInitiatorPat` policy through
    kernel's `createInitiatorPatGate` and **fails CLOSED** on an unreadable one.
    `runInitiatorContext.ts` is the AsyncLocalStorage scope that carries the run's
    `{ workspaceId, initiatedBy }` to it without threading a user id through the context-free VCS
    ports, and memoizes the whole decision per scope (one probe boundary re-mints per request).
    See `backend/docs/security-model.md`.

**See also:** `CLAUDE.md` → "Workspace RBAC enforcement", "Multi-runtime facades", "Conventions".
