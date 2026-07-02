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
- `slack/`, `email/` — notification channels; `writeback/`, `providers/`, `corpus/`,
  `provisioning-logs/`, `accountSettings/`, `localSettings/` — supporting services.
- `backend-registries.ts` — a loose registration file sitting among the module dirs.

**See also:** `CLAUDE.md` → "Post-release health flow"; `backend/docs/`
{`runner-pool-integration`, `environments-integration`, `github-integration`, `document-sources`}`.md`.
