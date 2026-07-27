# `@cat-factory/integrations` — opt-in integration services

External-system integration domain logic behind kernel ports; each service wires only when its
prerequisites are configured.

**Entry:** `src/index.ts`.

**Where things live** (`src/modules/*`):

- `github/`, `documents/`, `tasks/`, `tracker/` — VCS + document/issue sources.
- `environments/` — ephemeral-environment provisioning (the heaviest module) + `kubernetes/`,
  `runners/` (the self-hosted runner-pool transports).
- `datadog/` + `observability/` — release-health providers; `pagerduty/`, `incidentio/`,
  `incident/`, `incidentEnrichment/` — incident enrichment.
- `testSecrets/` — sealed per-service test credentials; `validation/` — per-service PRE-PR
  validation checks (the commands the harness runs before a PR opens; frame-chain resolved);
  `acceptance/` — the per-service ACCEPTANCE-CRITERIA store (durable given/when/outcome behaviour
  statements; frame-chain resolved, and the only one of the three that is a MEMBER-tier write).
- `slack/`, `email/`, `notificationWebhook/` — notification channels (the last one is the outbound
  HMAC-signed HTTP channel a headless integration registers to be pushed parked decisions); `writeback/`, `providers/`, `corpus/`,
  `provisioning-logs/`, `accountSettings/`, `localSettings/` — supporting services.
- `backend-registries.ts` — a loose registration file sitting among the module dirs.

**See also:** `CLAUDE.md` → "Post-release health flow", "Pre-PR validation flow",
"Acceptance-criteria store flow"; `backend/docs/`
{`runner-pool-integration`, `environments-integration`, `github-integration`, `document-sources`}`.md`.
