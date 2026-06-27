// Per-workspace incident-enrichment connection (PagerDuty + incident.io). Mirrors
// `@cat-factory/contracts` incident-enrichment. Credentials are write-only — the view
// returns only a presence `summary`.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  PagerDutyCredentials,
  IncidentIoCredentials,
  UpsertIncidentEnrichmentInput,
  IncidentEnrichmentSummary,
  IncidentEnrichmentView,
} from '@cat-factory/contracts'
