// Optional port for ENRICHING (not creating) an incident that an external
// incident-management system (PagerDuty / incident.io) already opened from the
// same Datadog monitors/SLOs the post-release-health gate watches. On a regression
// the on-call agent's investigation is posted onto that incident so responders see
// "which PR, what evidence, recommended action" — the one thing those systems can't
// derive themselves. Best-effort: a missing/unmatched incident is a no-op, never
// blocking the run or the in-app notification. NOT a notification channel: those
// systems already page off the same signals, so re-alerting them would duplicate.

export interface IncidentMatchQuery {
  workspaceId: string
  /**
   * The monitor/SLO ids the regression fired on. A provider PREFERS an active incident
   * whose text references one of these (the precise match), falling back to the most
   * recent active incident in the window when none reference a signal (these systems
   * don't reliably carry the originating monitor id).
   */
  signalIds: string[]
  /** Release marker time (epoch ms); only incidents active since then match. */
  since: number
}

/** The investigation update posted onto a matched incident. */
export interface IncidentUpdate {
  /** Short headline. */
  title: string
  /** Markdown investigation summary (suspect PR, evidence, recommendation). */
  body: string
  /** Web URL of the suspect PR, when known. */
  prUrl?: string
}

export interface IncidentEnrichmentProvider {
  /**
   * Find the active incident matching the regression and post the investigation update
   * onto it, atomically per provider. A no-op when no matching incident exists. Should
   * never throw for an expected miss; the caller treats any throw as best-effort.
   */
  enrich(query: IncidentMatchQuery, update: IncidentUpdate): Promise<void>
}

/**
 * Fans an enrichment out across several providers (PagerDuty + incident.io). Each is
 * matched + posted independently and isolated: one provider throwing (or not matching)
 * never blocks the others.
 */
export class CompositeIncidentEnrichmentProvider implements IncidentEnrichmentProvider {
  constructor(private readonly providers: IncidentEnrichmentProvider[]) {}

  async enrich(query: IncidentMatchQuery, update: IncidentUpdate): Promise<void> {
    await Promise.all(
      this.providers.map(async (provider) => {
        try {
          await provider.enrich(query, update)
        } catch {
          // best-effort: isolate each provider
        }
      }),
    )
  }
}
