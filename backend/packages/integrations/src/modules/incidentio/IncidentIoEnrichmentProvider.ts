import type {
  IncidentEnrichmentProvider,
  IncidentMatchQuery,
  IncidentUpdate,
} from '@cat-factory/kernel'
import { pickIncidentToEnrich } from '../incident/incident.logic.js'

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
  name?: string
  summary?: string
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
   * Find the live incident the regression most likely belongs to — preferring one whose
   * name/summary references a regressed signal id, else the most recent live incident in
   * the window — and post the investigation as an incident update onto it. No-op when none
   * matches.
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
    // incident.io's list endpoint has no server-side recency filter we can rely on (its
    // `status` filter keys on workspace-specific status ids, not categories), so we page
    // through with the `after` cursor and filter client-side. Bounded to a handful of
    // pages so a busy workspace's live incident isn't missed behind the first page (the
    // old `page_size=25`-only read) while we still can't loop unboundedly.
    const live: IoIncident[] = []
    let after: string | undefined
    for (let page = 0; page < 8; page++) {
      const params = new URLSearchParams({ page_size: '50' })
      if (after) params.set('after', after)
      const res = await this.fetchImpl(`${this.apiBase}/v2/incidents?${params.toString()}`, {
        method: 'GET',
        headers: this.headers(),
      })
      if (!res.ok) break
      const data = (await res.json()) as {
        incidents?: IoIncident[]
        pagination_meta?: { after?: string | null }
      }
      const batch = data.incidents ?? []
      for (const i of batch) {
        const category = i.incident_status?.category
        if (category && (category === 'closed' || category === 'declined')) continue
        if (!i.created_at || new Date(i.created_at).getTime() >= query.since) live.push(i)
      }
      after = data.pagination_meta?.after ?? undefined
      if (!after || batch.length === 0) break
    }
    return pickIncidentToEnrich(
      live.map((i) => ({
        raw: i,
        text: `${i.name ?? ''} ${i.summary ?? ''} ${i.reference ?? ''}`,
        createdAtMs: i.created_at ? new Date(i.created_at).getTime() : 0,
      })),
      query.signalIds,
    )
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
  return lines.join('\n')
}
