# `@cat-factory/integrations`: opt-in integration services

External-system integration domain logic behind kernel ports; each service wires only when its
prerequisites are configured.

**Entry:** `src/index.ts`.

**Where things live** (`src/modules/*`):

- `github/`, `documents/`, `tasks/`, `tracker/`: VCS + document/issue sources. `tasks/webhook/`
  holds the INBOUND side: the per-vendor verify+parse adapters behind
  `TaskSourceProvider.webhook`, driving `tasks/TrackerWebhookService.ts` (push intake fires a
  matching schedule; a ticket comment answers a parked review). The VCS-backed sources
  (`GitHubIssuesProvider`, `GitLabIssuesProvider`) store no credentials: each reads through the
  workspace's own connection row and is offered only when that row's `provider` is its own. Both
  are also REPO-BACKED, declared by a `TaskSourceProvider.repoScope` carrying the source's own
  id-to-repository comparison: its PRESENCE is what makes the HTTP layer resolve a repository
  before the search and what narrows the workspace's imported rows to one, so a repo-backed source
  added without it is a search that refuses and a list that never narrows. `tasks/writeback/`
  holds the OUTBOUND mirror of `tasks/webhook/`: the per-vendor `TaskSourceProvider.writeback`
  adapters (comment / resolve / mark in progress) that `writeback/IssueWritebackService.ts`
  dispatches through by registry, so a source is written back to because it DECLARES the
  capability rather than because a chain in that service names it. Each adapter also declares
  `authenticates`, the fact that decides what an unreadable tracker connection costs it: the two
  repo-backed sources are `out-of-band` (they post through the workspace's VCS installation and
  read that row only for the inbound reply secret), Jira and Linear are `stored-connection`. The
  two repo-backed sources
  share one factory, and its comment goes through the client's `commentOnIssue`, never `comment`:
  they are the same call only on GitHub, and on GitLab `comment` addresses merge requests. Its
  connection read rides `ctx.once`, because the caller fans out over a block's linked issues and
  the row is the same for all of them.
  `tasks/` also holds the two issue
  PULLS, structural twins differing only in who decides: `BugIntakeService.ts` (the recurring
  step claims the oldest match unattended) and `BugHuntService.ts` (a human picks from a rated
  board scan), both over the `listBugCandidates` provider capability. `listBoards` backs the
  hunt's board picker and belongs ONLY to a repo-LESS source: a repo-backed one hunts the
  repository its service frame is linked to, and offering its reachable repositories as boards
  would aim a hunt at one no service on that board points to.
- `environments/`: ephemeral-environment provisioning (the heaviest module) + `kubernetes/`,
  `runners/` (the self-hosted runner-pool transports).
- `compose/`: the Docker Compose environment backend + the STACK RECIPE machinery. `compose-sources.ts`
  is the one seam that turns an ordered `-f` layer list into text + the path each layer lands at,
  whether the layer is a path in the repo being provisioned, an INLINE compose document, or a file in
  ANOTHER repo (read checkout-free through the workspace's VCS connection). Its pure placement rules
  (which layer anchors `--project-directory`, and therefore what the host-escape guard measures
  against) are kernel's `domain/compose-sources.ts`, shared with the shared-stack bring-up so the two
  paths cannot drift.
- `sharedStack/`: long-lived compose infra a per-PR environment attaches to over an external network.
  `SharedStackService` owns CRUD (runtime-neutral) + the host-daemon bring-up (local facade only); a
  stack whose layers are all inline / from other repos needs NO repo of its own and materializes an
  empty working tree instead of cloning. `SharedStackSeeder.ts` is the deployment-declared side:
  `startNode`/`startLocal`'s `seedSharedStacks` flows through it, idempotently by NAME.
- `datadog/` + `observability/`: release-health providers; `pagerduty/`, `incidentio/`,
  `incident/`, `incidentEnrichment/`: incident enrichment.
- `providers/`: the direct-vendor key pool (`ApiKeyService`) plus the per-workspace OpenRouter
  catalog. `OpenRouterCatalogService.ts` leases the key and persists the enabled subset;
  `openRouterModels.ts` is the PRICE fold, split out because it is the intricate half: OpenRouter
  publishes a base rate, an account `discount`, up to three cache classes and conditional
  `overrides` bands, and the bands are folded to their MAXIMUM (which one applies depends on the
  prompt length and the wall clock, neither known at refresh time, and a budget may only be wrong
  upward). `scripts/check-openrouter-pins.mjs` re-reads the live catalogue against the spend
  table's pinned slugs.
- `mcpOAuth/`: the per-workspace OAuth grants a remote (`http`) MCP tool server needs.
  `McpOAuthService.ts` owns the lifecycle (start → sealed state → exchange → refresh → disconnect)
  and `mcpOAuthClient.ts` is the wire half (RFC 9728/8414 endpoint discovery plus the three token
  calls, hand-rolled on `fetch` so it bundles into a Worker). Separate from `capabilityCredentials/`
  on purpose: a grant expires, is rewritten by the dispatch path, and belongs to a person's vendor
  account, none of which a typed credential's shape can hold. See `backend/docs/mcp-tool-servers.md`.
- `mcpAuthServer/`: the mirror image, this deployment as the AUTHORIZATION SERVER for its own
  hosted MCP endpoint. `McpAuthorizationServer.ts` is the whole flow (dynamic registration, the
  consent hand-off, the code exchange that mints a public-API key) and persists NOTHING: the client
  id, the in-flight request and the code are each sealed into the value the other party carries.
  `metadataDocuments.ts` holds the RFC 9728/8414 documents plus the 401 challenge, and lives here
  rather than in the controller so `mcpAuthorizationInterop.test.ts` can drive the CONSUMING walk
  next door over them. See `backend/docs/mcp-authorization.md`.
- `testSecrets/`: sealed per-service test credentials; `validation/`: per-service PRE-PR
  validation checks (the commands the harness runs before a PR opens; frame-chain resolved) plus
  the DEPENDENCY PREPOPULATION install on the same row (run before the agent's first turn, and
  independently settable; see `CLAUDE.md` → "Dependency prepopulation"),
  plus `detectValidationChecksFromRepo` (the repo-root read behind the inspector's "Detect"
  button: one listing, then only the manifests it proved exist; the rules are pure kernel).
- `slack/`, `email/`, `notificationWebhook/`: notification channels (`email/` carries both the
  per-account sender connection and the `EmailNotificationChannel` over it; the last one is the
  outbound HMAC-signed HTTP channel a headless integration registers to be pushed parked decisions).
  Slack and email are ALERT transports and deliver on the `raised` edge alone (kernel's
  `isAlertingDelivery`), since neither a chat post nor a mail can be unsaid; the webhook is a
  STATE transport and takes every edge, its receiver keying on `notification.status`; `writeback/`, `providers/`, `corpus/`,
  `provisioning-logs/`, `accountSettings/`, `localSettings/`: supporting services. `writeback/`
  owns both directions of the tracker clarification loop: `reviewQuestions.logic.ts` (questions
  OUT) and its sibling `reviewReplies.logic.ts` (the reply grammar + the acknowledgement), kept
  side by side because they share the finding ids, and splitting them is how the two halves would
  desync. `IssueWritebackService` beside them is the SHARED half of every writeback (settings
  gating, the linked-issue fan-out and its isolation, the per-source connection read, the
  parked-review marker); the vendor half lives on the providers in `tasks/writeback/`.
- `audit/`: `AuditService`, the ONE writer of the account audit log and the implementation of
  kernel's `AuditRecorder`. It lives here rather than beside the tenancy services that call it
  because those are in `@cat-factory/workspaces`, which the facades do not depend on; they consume
  the kernel PORT, so only the facade that builds the service needs to see this. `record` never
  throws (a store outage costs the row, not the mutation) but IS awaited, because an un-awaited
  write is dropped when a Worker isolate freezes after the response; `listByAccount` propagates,
  because an empty page and an unreachable store are opposite facts.
- `backend-registries.ts`: a loose registration file sitting among the module dirs.

**See also:** `CLAUDE.md` → "Post-release health flow", "Pre-PR validation flow", "Inbound tracker webhooks", "Bug hunt"; `backend/docs/`
{`runner-pool-integration`, `environments-integration`, `github-integration`, `document-sources`, `bug-hunt`}`.md`.
