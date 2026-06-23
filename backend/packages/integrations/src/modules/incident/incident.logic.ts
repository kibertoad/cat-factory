// Shared, pure selection logic for the incident-enrichment providers (PagerDuty +
// incident.io). On a release regression the on-call investigation is annotated onto the
// incident the regression most likely belongs to. Neither vendor reliably carries the
// originating Datadog monitor/SLO id, so we PREFER an active incident whose text
// references one of the regressed signal ids (the precise match) and fall back to the
// most recent active incident in the window when none do.

/** A vendor-agnostic incident candidate the picker ranks. */
export interface IncidentCandidate<T> {
  /** The underlying vendor incident to return when chosen. */
  raw: T
  /** Free text searched for a signal-id reference (title + summary/description). */
  text: string
  /** Creation time (epoch ms); newest wins among equally-matching candidates. */
  createdAtMs: number
}

/**
 * Pick the incident to enrich from the active candidates: the most recent one whose text
 * references a regressed signal id, else the most recent active one. Returns null when
 * there are no candidates.
 */
export function pickIncidentToEnrich<T>(
  candidates: IncidentCandidate<T>[],
  signalIds: string[],
): T | null {
  if (candidates.length === 0) return null
  const byRecency = [...candidates].sort((a, b) => b.createdAtMs - a.createdAtMs)
  if (signalIds.length > 0) {
    const referenced = byRecency.find((c) =>
      signalIds.some((id) => id !== '' && c.text.includes(id)),
    )
    if (referenced) return referenced.raw
  }
  return byRecency[0]!.raw
}
