import type {
  IncidentEnrichmentProvider,
  IncidentMatchQuery,
  IncidentUpdate,
} from '@cat-factory/kernel'

// Enriches (does NOT create) an incident.io incident already opened from the same Datadog
// monitors/SLOs the post-release-health gate watches. On a regression the on-call agent's
// investigation is posted as an incident update so responders see "which PR, what
// evidence, recommended action". Best-effort: no matching live incident → no-op. NOT a
// notification channel — incident.io already alerted off the same signals.

type FetchLike = typeof fetch

export interface IncidentIoEnrichmentProviderOptions {
  /** incident.io API key (Bearer). */
  apiKey: string
  /** API base; defaults to the public endpoint. */
  apiBase?: string
  fetchImpl?: FetchLike
}

interface IoIncident {
  id: string
  reference?: string
  permalink?: string
  created_at?: string
  incident_status?: { category?: string }
}

export class IncidentIoEnrichmentProvider implements IncidentEnrichmentProvider {
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike

  constructor(private readonly opts: IncidentIoEnrichmentProviderOptions) {
    this.apiBase = (opts.apiBase ?? 'https://api.incident.io').replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * Find the most-recent live incident created since the release marker and post the
   * investigation as an incident update onto it. No-op when none matches. incident.io
   * incidents don't carry the originating Datadog monitor id, so we match on recency
   * within the release window among non-closed incidents.
   */
  async enrich(query: IncidentMatchQuery, update: IncidentUpdate): Promise<void> {
    const incident = await this.findActiveIncident(query)
    if (!incident) return
    const res = await this.fetchImpl(`${this.apiBase}/v2/incident_updates`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        incident_id: incident.id,
        message: renderUpdate(update),
      }),
    })
    if (!res.ok) {
      throw new Error(`incident.io update failed: HTTP ${res.status}`)
    }
  }

  private async findActiveIncident(query: IncidentMatchQuery): Promise<IoIncident | null> {
    const res = await this.fetchImpl(`${this.apiBase}/v2/incidents?page_size=25`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { incidents?: IoIncident[] }
    const live = (data.incidents ?? [])
      .filter((i) => {
        const category = i.incident_status?.category
        if (category && (category === 'closed' || category === 'declined')) return false
        if (!i.created_at) return true
        return new Date(i.created_at).getTime() >= query.since
      })
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    return live[0] ?? null
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.apiKey}`,
      accept: 'application/json',
    }
  }
}

/** Render an investigation update into an incident.io update message (markdown). */
function renderUpdate(update: IncidentUpdate): string {
  const lines = [`**cat-factory on-call: ${update.title}**`, '', update.body]
  if (update.prUrl) lines.push('', `Suspect PR: ${update.prUrl}`)
  if (update.revertUrl) lines.push(`Proposed revert: ${update.revertUrl}`)
  return lines.join('\n')
}
