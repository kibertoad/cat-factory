// Per-workspace incident-enrichment connection (PagerDuty + incident.io). Mirrors
// `@cat-factory/contracts` incident-enrichment. Credentials are write-only — the view
// returns only a presence `summary`.

export interface PagerDutyCredentials {
  apiToken: string
  fromEmail: string
}

export interface IncidentIoCredentials {
  apiKey: string
}

/** Write input — set one or both providers; an omitted group is left unchanged. */
export interface UpsertIncidentEnrichmentInput {
  pagerDuty?: PagerDutyCredentials
  incidentIo?: IncidentIoCredentials
}

export interface IncidentEnrichmentSummary {
  pagerDuty: boolean
  incidentIo: boolean
}

export interface IncidentEnrichmentView {
  connected: boolean
  summary: IncidentEnrichmentSummary | null
}
