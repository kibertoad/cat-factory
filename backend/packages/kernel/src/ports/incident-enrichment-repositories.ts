// Persistence port for the per-workspace incident-enrichment connection (PagerDuty
// + incident.io). Mirrors across the D1 (Cloudflare) and Drizzle/Postgres (Node)
// facades (runtime parity is mandatory). Credentials are sealed at rest by the
// facade's SecretCipher; the record carries the sealed blob (never plaintext) plus a
// non-secret summary. Modelled on ObservabilityConnectionRepository.

/** A workspace's incident-enrichment connection. Exactly one per workspace. */
export interface IncidentEnrichmentConnectionRecord {
  workspaceId: string
  /**
   * Sealed (by the facade SecretCipher) JSON of `{ pagerDuty?, incidentIo? }`.
   * Opaque to everything but the enrichment provider, which decrypts it at
   * enrichment time.
   */
  credentials: string
  /** Non-secret presence summary as JSON (e.g. `{"pagerDuty":true,"incidentIo":false}`). */
  summary: string
  createdAt: number
  updatedAt: number
}

export interface IncidentEnrichmentConnectionRepository {
  get(workspaceId: string): Promise<IncidentEnrichmentConnectionRecord | null>
  upsert(record: IncidentEnrichmentConnectionRecord): Promise<void>
  delete(workspaceId: string): Promise<void>
}
