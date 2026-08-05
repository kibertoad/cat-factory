# `@cat-factory/integrations`: opt-in integration services

External-system integration domain logic behind kernel ports; each service wires only when its
prerequisites are configured.

**Entry:** `src/index.ts`.

**Where things live** (`src/modules/*`):

- `github/`, `documents/`, `tasks/`, `tracker/`: VCS + document/issue sources. `tasks/webhook/`
  holds the INBOUND side: the per-vendor verify+parse adapters behind
  `TaskSourceProvider.webhook`, driving `tasks/TrackerWebhookService.ts` (push intake fires a
  matching schedule; a ticket comment answers a parked review). `tasks/` also holds the two issue
  PULLS, structural twins differing only in who decides: `BugIntakeService.ts` (the recurring
  step claims the oldest match unattended) and `BugHuntService.ts` (a human picks from a rated
  board scan), both over the `listBugCandidates` / `listBoards` provider capabilities.
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
- `mcpOAuth/`: the per-workspace OAuth grants a remote (`http`) MCP tool server needs.
  `McpOAuthService.ts` owns the lifecycle (start → sealed state → exchange → refresh → disconnect)
  and `mcpOAuthClient.ts` is the wire half (RFC 9728/8414 endpoint discovery plus the three token
  calls, hand-rolled on `fetch` so it bundles into a Worker). Separate from `capabilityCredentials/`
  on purpose: a grant expires, is rewritten by the dispatch path, and belongs to a person's vendor
  account, none of which a typed credential's shape can hold. See `backend/docs/mcp-tool-servers.md`.
- `testSecrets/`: sealed per-service test credentials; `validation/`: per-service PRE-PR
  validation checks (the commands the harness runs before a PR opens; frame-chain resolved) plus
  the DEPENDENCY PREPOPULATION install on the same row (run before the agent's first turn, and
  independently settable; see `CLAUDE.md` → "Dependency prepopulation"),
  plus `detectValidationChecksFromRepo` (the repo-root read behind the inspector's "Detect"
  button: one listing, then only the manifests it proved exist; the rules are pure kernel).
- `slack/`, `email/`, `notificationWebhook/`: notification channels (the last one is the outbound
  HMAC-signed HTTP channel a headless integration registers to be pushed parked decisions); `writeback/`, `providers/`, `corpus/`,
  `provisioning-logs/`, `accountSettings/`, `localSettings/`: supporting services. `writeback/`
  owns both directions of the tracker clarification loop: `reviewQuestions.logic.ts` (questions
  OUT) and its sibling `reviewReplies.logic.ts` (the reply grammar + the acknowledgement), kept
  side by side because they share the finding ids, and splitting them is how the two halves would
  desync.
- `backend-registries.ts`: a loose registration file sitting among the module dirs.

**See also:** `CLAUDE.md` → "Post-release health flow", "Pre-PR validation flow", "Inbound tracker webhooks", "Bug hunt"; `backend/docs/`
{`runner-pool-integration`, `environments-integration`, `github-integration`, `document-sources`, `bug-hunt`}`.md`.
