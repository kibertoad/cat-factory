# `@cat-factory/integrations` — opt-in integration services

External-system integration domain logic behind kernel ports; each service wires only when its
prerequisites are configured.

**Entry:** `src/index.ts`.

**Where things live** (`src/modules/*`):

- `github/`, `documents/`, `tasks/`, `tracker/` — VCS + document/issue sources. `tasks/webhook/`
  holds the INBOUND side: the per-vendor verify+parse adapters behind
  `TaskSourceProvider.webhook`, driving `tasks/TrackerWebhookService.ts` (push intake fires a
  matching schedule; a ticket comment answers a parked review). `tasks/` also holds the two issue
  PULLS, structural twins differing only in who decides: `BugIntakeService.ts` (the recurring
  step claims the oldest match unattended) and `BugHuntService.ts` (a human picks from a rated
  board scan), both over the `listBugCandidates` / `listBoards` provider capabilities.
- `environments/` — ephemeral-environment provisioning (the heaviest module) + `kubernetes/`,
  `runners/` (the self-hosted runner-pool transports).
- `datadog/` + `observability/` — release-health providers; `pagerduty/`, `incidentio/`,
  `incident/`, `incidentEnrichment/` — incident enrichment.
- `testSecrets/` — sealed per-service test credentials; `validation/` — per-service PRE-PR
  validation checks (the commands the harness runs before a PR opens; frame-chain resolved),
  plus `detectValidationChecksFromRepo` (the repo-root read behind the inspector's "Detect"
  button — one listing, then only the manifests it proved exist; the rules are pure kernel).
- `slack/`, `email/`, `notificationWebhook/` — notification channels (the last one is the outbound
  HMAC-signed HTTP channel a headless integration registers to be pushed parked decisions); `writeback/`, `providers/`, `corpus/`,
  `provisioning-logs/`, `accountSettings/`, `localSettings/` — supporting services. `writeback/`
  owns both directions of the tracker clarification loop: `reviewQuestions.logic.ts` (questions
  OUT) and its sibling `reviewReplies.logic.ts` (the reply grammar + the acknowledgement) — kept
  side by side because they share the finding ids, and splitting them is how the two halves would
  desync.
- `backend-registries.ts` — a loose registration file sitting among the module dirs.

**See also:** `CLAUDE.md` → "Post-release health flow", "Pre-PR validation flow", "Inbound tracker webhooks", "Bug hunt"; `backend/docs/`
{`runner-pool-integration`, `environments-integration`, `github-integration`, `document-sources`, `bug-hunt`}`.md`.
