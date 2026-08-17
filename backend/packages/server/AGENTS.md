# `@cat-factory/server`: runtime-neutral HTTP layer

The shared Hono app **every runtime facade serves** (no `@cloudflare/*` dep). Controllers
resolve everything from `c.get('container')` (a `ServerContainer` = the domain `Core` + config

- `agentRunRepository` + gateways).

**Entry:** `src/index.ts`; `src/app.ts`: `registerCoreControllers(app)`.

**Where things live:**

- `modules/*/…Controller.ts`: the ~50 Hono controllers, one dir per module.
- `modules/publicApi/`: the key-authenticated `/api/v1` surface (NOT behind the session gate):
  `PublicApiController` (jobs/board/pipelines/notifications), `PublicDecisionController` (a run's
  parked human decisions: the composer over `publicApi/decisions/`, whose `scope.ts` gates a run
  for the key, `projection.ts` turns a run into the decision list, and one `*Routes.ts` per park
  family answers it — approval gates and agent questions, the three iterative-review loops, the
  container-backed PR review and human-verdict gates, and `companionRoutes.ts` for follow-up triage
  plus the interview gates), `PublicDebugController` (the
  `read`-scoped remote **run debugging** reads over a run's telemetry + provisioning log, sized so
  an LLM can walk them within a context budget; see `docs/debug-api.md`), `PublicEvidenceController`
  (the `read`-scoped run **evidence** reads for a consumer that has to JUDGE a run rather than debug
  one: the engine's verification report composed on read (the same bundle the pull request carries,
  so there is no second projection to disagree with it) plus the run's captured artifacts and their
  BYTES, the one route on this surface that is hand-mounted because an image response cannot be a
  contract; its run-scoped reads take `decisions/scope.ts`'s NARROWER rule, because one path prefix
  carries one authorization model), `PublicMergeEvidenceController` (the merge-EVIDENCE loop: a run's
  merge decision with its backend-derived change class and the merger's scores, the workspace's
  per-class rollups, and the reviewer-effort TAG a landed pull request earned; the tag at `write`,
  not the `admin` that `act` needs, since tagging merges nothing), `PublicSpendController` (the
  `read`-scoped **spend analytics** read at `/api/v1/usage/spend`: one dimension of
  `ReportsService` over a window, scoped to the key's own account AND board, so the
  cost-attribution axes the panel serves account-wide (repository, ticket, run) are reachable
  headlessly without the cross-workspace view the admin gate exists for), `PublicKeyController` (HEADLESS key provisioning at `admin`
  scope, delegating to the same `PublicApiKeyService` the session panel calls; the mintable rungs
  are derived from the gate, so a key minted here can never mint another),
  `PublicProvisioningController` (**deployment provisioning**, all `admin`: repo bootstrap, the
  cluster connection a run's environments deploy onto, a service's manifest source, and the three
  reads that report what this deployment has wired. Every public shape it answers in is a
  PROJECTION of an internal one, so its mappers are where an internal rename stops being a public
  break; the model read shares `modules/models/workspaceCatalog.ts` with the SPA's own picker,
  because two surfaces answering "can a run dispatch here" differently is the bug that seam
  exists to prevent), `PublicMcpController` (the
  HOSTED **MCP** endpoint, `POST /api/v1/mcp`: mounts `@cat-factory/mcp-server`'s server behind a
  Web-standard Streamable HTTP transport, stateless per request, with the key's SCOPE deciding the
  tool list and every tool call looping back through `http/loopback.ts` to `/api/v1` under the
  caller's own key; deliberately NOT an OpenAPI operation, see `docs/public-api.md`),
  `publicApiAuth.ts` (the
  shared bearer gate + `read ⊂ write ⊂ decide ⊂ admin` ladder, plus `authorizeOrThrow` for a route
  with no contract-declared response and `bearerToken` for the one that FORWARDS the key),
  `publicApiAdmission.ts` (what an external
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
  uploaded whole, with the task rolled back if an attachment does not land). `keyProjection.ts` holds the ONE
  record-to-wire projection of a public-API key, shared by the session-authed management routes and
  the headless provisioning ones (they had a copy each, which is how a field lands on one surface
  and silently not the other), and `runIdentityVisibility.ts` decides who may read the
  `externalIdentity` a run was pinned with: an identity-bearing key sees only its own runs', and a
  withheld one is FLAGGED rather than blanked, since `null` already means "this run names nobody".
  `taskTypeFields.ts`
  serves the task-type CATALOG and maps a caller's `fields` bag onto the internal shape at both
  doors; the PATCH half MERGES over what the task already carries where creation takes the bag
  whole, because the surface never serves that bag back, so a replacing patch would ask a caller
  to restate values it cannot read. See
  [ADR 0047](../../docs/adr/0047-headless-clarification-loop.md),
  `backend/docs/adr/0030-public-api-surface.md` and
  `backend/docs/adr/0043-public-decision-surface.md`.
- `modules/toolServers/`: the tool-server (MCP) **operability** surface, `secrets.manage`-gated
  read included. `declaredToolServers.ts` projects every registration non-secretly (unioning the
  walk over `kindsWithCapabilities()` with `allToolServers()`, so a registration attached to NO
  kind is reported with an empty `declaredBy` instead of being invisible); `probeToolServer.ts`
  resolves the credentials through the container's `toolSecretResolver` — the SAME composed chain a
  dispatch uses, reserved-key floor and all — and reconciles `allowedTools` against what the server
  really exposes; `mcpProbe.ts` is a hand-rolled Streamable-HTTP client (three POSTs over `fetch`,
  no MCP SDK, so nothing Node-reaching enters a module every facade bundles). A `stdio` server and a
  loopback url are REFUSED by name rather than probed, because the backend is not the run container.
  `McpOAuthCallbackController.ts` is the vendor's redirect target and is deliberately NOT in this
  gated mount: it is a third-party browser navigation, so it is mounted at the app ROOT and gates
  itself on the sealed state, the user who started the flow, and a re-loaded `secrets.manage`.
  See `backend/docs/mcp-tool-servers.md`.
- `modules/mcpAuthServer/`: MCP authorization on the SERVING side, in two controllers split by what
  authenticates them. `McpAuthorizationController.ts` is unauthenticated by construction (the
  metadata documents, dynamic client registration, the authorize redirect and the token exchange:
  a host has no credential yet, which is what it came for) and answers refusals in OAuth's own
  `{ error, error_description }` rather than the deployment envelope.
  `McpAuthorizationConsentController.ts` is the half that needs a human, root-mounted and
  session-gated, re-resolving `secrets.manage` on the board the person PICKED. `consentRedirect.ts`
  holds the SPA path both halves derive. See `backend/docs/mcp-authorization.md`.
- `modules/tasks/TaskWebhookController.ts` + `webhooks/`: the PUBLIC, session-gate-bypassing
  webhook receivers (`/github`, `/vcs/:provider`, `/webhooks/tasks/:source/:workspaceId`) and their
  shared body-limit + signature-rejection logging. Each verifies over the RAW body before parsing,
  acks fast, and hands off through a `gateways` seam. The tracker one is the odd shape: its
  workspace rides the PATH (a tracker delivery has no installation id to resolve one from) and its
  secret is per CONNECTION rather than per deployment. See
  `backend/docs/adr/0032-tracker-webhook-intake.md`.
  These and the vendor OAuth callbacks (`/slack`, `/tasks` for Linear, `/documents` for every
  OAuth-capable document source) are ONE list, `app.ts`'s `PROVIDER_CALLBACK_CONTROLLERS`, and
  every mount in it MUST also appear in `authGate.ts`'s `PUBLIC_PREFIXES`. That pairing is the
  point of the list: a receiver missing from the allowlist is not gated but UNREACHABLE, since its
  caller has no session to present, and it fails only against the live vendor, on a redirect or a
  delivery nobody can retry. `http/publicPrefixes.test.ts` pins the two together, deriving both
  sides, after the omission shipped twice.
- `agents/`: the **shared, runtime-neutral** agent-dispatch layer: `CompositeAgentExecutor`,
  `ContainerAgentExecutor`, `RunnerJobClient`, `ContainerRepoBootstrapper`, `ModelRouter`.
  Two collaborators split out of the executor to keep it inside its (ratcheting-down) size
  budget: `containerAgentLogging.ts` (the workflow↔container seam's log vocabulary) and
  `agentContextRecord.ts` (the observability snapshot's ALLOW-LIST projection; the one place
  that decides what of a dispatch may be persisted, so a new body field is opt-in, never
  inherited). A third, `toolTrajectory.ts`, owns the poll's TOOL-CALL drain: it applies the body
  gate ONCE and hands the same gated batch to the trajectory store and to any wired trace sink,
  so the two can never end up with different answers about what a workspace permitted. A fourth,
  `dispatchTokenMint.ts`, owns the dispatch CREDENTIAL: it is the one place that decides whose
  token a job carries (the run initiator's PAT, else the deployment's) and how wide it is minted
  (`repository_ids` narrowed to `jobTokenRepoIds`, the repos that dispatch resolved). Both facades
  build their mint through it, because the two decisions interact (scoping applies only to the App
  token, a PAT cannot be narrowed at all) and they previously held byte-identical copies of half of
  it. EVERY path that hands a container a GitHub credential goes through it: the step executor, the
  repo bootstrapper, the env-config repairer, preview jobs and the deploy clone target. What holds
  that totality is the `MintInstallationToken` ctx, whose presence is what marks a mint as a
  DISPATCH mint and whose `repoIds` is required, so a new dispatcher cannot ship without deciding
  its scope; an engine call passes no ctx and stays installation-wide. `containerAgentBody.ts`
  holds the auxiliary-repo resolution the scope reads, which is why that resolution is a dispatch
  INPUT rather than a tail step. Every dispatcher of the `agent` kind (the executor, the bootstrapper and
  `ContainerEnvConfigRepairer`) puts `workspaceId`/`executionId` on its job body so the
  container's own log lines join to the backend's.
  `agents/jobBody.ts` renders the harness job body from ONE path: compose the prompt, resolve the
  kind's `AgentStepSpec` off the agent-kind registry (a container-backed companion synthesizes one;
  an unregistered kind falls back to the implementer's), build the generic body. There is no
  `switch (agentKind)` here and none in `containerAgentResult.ts`, whose kind-aware coercion is one
  `registry.mapStructuredResult(kind)` lookup — both switches went when the built-ins became
  registrations. What still lives in `agents/prompts.ts` is what is NOT about a kind: the tester
  infra spec (derived per run from the frame's profile and what the run provisioned) and the PR body.
  `agents/harnessContract.ts` is the BACKEND half of the filesystem contract with the executor
  harness (the sibling checkout directory's name, the four sentinel paths). The harness image can
  depend on no workspace package, so both halves are computed independently and pinned against each
  other by the harness's own `harness-contract.conformity.test.ts`.
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
- `auth/`: HMAC signing, GitHub/Google OAuth helpers, WS tickets (`wsTicket.ts`), and
  `auth/oidc/` — the enterprise-SSO adapter: `discovery.ts` (the cached
  `/.well-known/openid-configuration` + JWKS read, and the key-rotation refetch),
  `OidcClient.ts` (Authorization Code + PKCE, ID-token verification via `jose` against an
  asymmetric-only algorithm allow-list), `claims.ts` (the pure identity/admission rules).
  ONE adapter serves every OIDC provider; nothing under here branches on which one answered.
- `modules/auth/loginFlow.ts`: the mechanics EVERY redirecting login provider shares — the
  cookie-bound CSRF state, the allow-listed post-login redirect (`pickPostLoginRedirect` guards a
  token-exfiltration primitive), the session mint, the invite handling. A new provider extends
  this, never a second copy. `modules/auth/ssoRoutes.ts` is the SSO registrar; its round-trip state
  rides an httpOnly cookie rather than the URL, because PKCE's verifier and OIDC's nonce are
  secrets. Configuration + admission model: [`backend/docs/auth.md`](../../docs/auth.md).
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
  CORS and the per-request container). Mints/adopts `X-Request-Id`, adopts an inbound W3C
  `traceparent` as `{ traceId, spanId }` (kernel's `parseTraceparent`; malformed ⇒ ignored, never
  refused), binds a request-scoped child
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
  `requireWorkspacePermission`; the admin-tier controller middleware, plus
  `requireWorkspacePermissionIncludingReads` for the two controllers whose READ is the sensitive
  half — the capability-credential checklist and the tool-server inventory both project the
  credential KEY NAMES this deployment's capabilities want) and `optionalJsonBody`
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
- `persistence/binaryArtifactStore.ts`: per-ACCOUNT binary-artifact store resolution, composing the
  runtime's metadata store with the backend an account selected. Both facades' factories serve only
  the platform's own backends; a store the DEPLOYMENT registered is resolved here, so custom stores
  work identically on every runtime with neither facade knowing about them
  ([`custom-binary-stores.md`](../../docs/custom-binary-stores.md)).
- `test/coverageScan.ts` + the `*.coverage.spec.ts` beside it: the guards for the rules a
  typecheck cannot hold, where a field must stay OPTIONAL because one caller is entitled to the
  default (`initiatedByRole`, `intakeOrigin`). Each classifies every call site and fails on a new
  one until someone writes down which bucket it is in. They read through `loadCode`, which strips
  comments first: a guard matching raw text is satisfied by a file that merely NAMES the literal
  it should pass, which is exactly how one stayed green over a call site missing its value.
- The **mothership-mode machine API** (`/internal/*`, machine-token authed, mounted on both
  facades: see `docs/initiatives/mothership-mode.md`): `persistence/rpc.ts` +
  `persistence/rpc-allowlist*.ts` + `modules/persistence/` (the repository RPC, its per-domain
  allow-list tables and `dispatchScope.ts`'s per-request entity resolvers, plus GitHub
  installation-token delegation),
  `persistence/agentKinds.ts` + `modules/agentKinds/AgentKindsController.ts` (the agent-kind
  CAPABILITY layer: the one code-registered source that MERGES with the node's own registry,
  because a kind's executable half cannot cross a wire while the skills and tool servers a
  deployment ASSIGNS to it are data),
  `secrets/sealedSecretSources.ts` + `persistence/secretDelegation.ts` +
  `modules/persistence/SecretDelegationController.ts` (SECRET delegation: the mothership opens,
  and seals, an ORG credential a node holds no key for. The one machine surface answering with a
  PLAINTEXT credential, which is why the request names a ROW rather than an envelope and the
  readable sources are a CLOSED table),
  `events/machineEvents.ts` + `events/machineSubscribe.ts` +
  `modules/events/EventsRelayController.ts` (real-time in BOTH directions; the upstream publish
  and the node's inbound per-workspace subscription, whose handshake is handed to the SAME
  `gateways.realtime.upgrade` seam the browser stream uses), and `notifications/machineNotifications.ts` +
  `modules/notifications/NotificationRelayController.ts` (notification delivery through the org's
  external transports; the ROUTED half — the notification manager, the per-channel gate and the
  email transport — is built once for both facades in `notifications/notificationDelivery.ts`), and `telemetry/machineTelemetry.ts` +
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
  verification report as a marker-delimited region of the PR description, on EVERY pull request
  the run opened: `resolveTargets` is the only addressing step, joining the block's recorded peer
  PRs onto ONE multi-repo repo resolution, and each target it returns carries its own repo +
  connection so `publish` writes without reading anything).
  - The client is at a ratcheting size budget, so cohesive concerns live BESIDE it and it keeps a
    thin delegate. Each takes the client's bound `request` rather than the client itself, which is
    also what makes them testable without a client: `reviewPosting.ts` + `reviewThreads.ts` (the
    REST and GraphQL halves of PR review), `searchApi.ts`, `branchProtection.ts` (the
    security-preflight probe + the required-approvals lookup; together because they read the SAME
    resource and must not learn failure modes separately), `repoContents.ts` (the four `/contents`
    and `/git/trees` reads; together because what they share IS the classification: which statuses
    are ANSWERS there, plus the two facts that endpoint reports as something they are not, an
    over-limit blob as a `403` and non-UTF-8 bytes as a string), `viewerTokenReads.ts` (the
    CALLER-token repo reads behind the personal-PAT picker; mints, caches and rate-limit-accounts
    nothing), and `githubHttpHelpers.ts` (`GitHubApiError` + the shared request constants).
  - `github/ProviderRoutingGitHubClient.ts` fronts the `github` module in a deployment running BOTH
    a GitHub App and GitLab PAT connect, dispatching each installation-keyed call by the
    connection's stored provider. Reflective (a `Proxy`) rather than a hand-written delegate,
    because 20 of the port's 53 methods are OPTIONAL: a delegate that omits one still typechecks
    and reports a capability the deployment HAS as absent. See its header for what that cost.
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
