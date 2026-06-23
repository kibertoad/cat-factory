import type {
  IncidentEnrichmentProvider,
  IncidentMatchQuery,
  IncidentUpdate,
} from '@cat-factory/kernel'

// Enriches (does NOT create) a PagerDuty incident that PagerDuty already opened from the
// same Datadog monitors/SLOs the post-release-health gate watches. On a regression the
// on-call agent's investigation is posted as an incident note so responders see "which
// PR, what evidence, recommended action". Best-effort: no matching active incident → no-op.
// NOT a notification channel — PagerDuty already paged off the same signals.

type FetchLike = typeof fetch

export interface PagerDutyEnrichmentProviderOptions {
  /** PagerDuty REST API token (a general-access or user token). */
  apiToken: string
  /** Email of the user notes are attributed to (PagerDuty requires a `From` header). */
  fromEmail: string
  /** API base; defaults to the public endpoint. */
  apiBase?: string
  fetchImpl?: FetchLike
}

interface PdIncident {
  id: string
  html_url?: string
  created_at?: string
}

export class PagerDutyEnrichmentProvider implements IncidentEnrichmentProvider {
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike

  constructor(private readonly opts: PagerDutyEnrichmentProviderOptions) {
    this.apiBase = (opts.apiBase ?? 'https://api.pagerduty.com').replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * Find the most-recent active (triggered/acknowledged) incident created since the
   * release marker and post the investigation as a note onto it. No-op when none
   * matches. PagerDuty incidents don't carry the originating Datadog monitor id, so we
   * match on recency within the release window — good enough to annotate the incident
   * the deploy most likely caused.
   */
  async enrich(query: IncidentMatchQuery, update: IncidentUpdate): Promise<void> {
    const incident = await this.findActiveIncident(query)
    if (!incident) return
    const res = await this.fetchImpl(`${this.apiBase}/incidents/${incident.id}/notes`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ note: { content: renderNote(update) } }),
    })
    if (!res.ok) {
      throw new Error(`PagerDuty note failed: HTTP ${res.status}`)
    }
  }

  private async findActiveIncident(query: IncidentMatchQuery): Promise<PdIncident | null> {
    const since = new Date(query.since).toISOString()
    const params = new URLSearchParams({ since, 'statuses[]': 'triggered' })
    params.append('statuses[]', 'acknowledged')
    params.set('sort_by', 'created_at:desc')
    params.set('limit', '1')
    const res = await this.fetchImpl(`${this.apiBase}/incidents?${params.toString()}`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { incidents?: PdIncident[] }
    return data.incidents?.[0] ?? null
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Token token=${this.opts.apiToken}`,
      accept: 'application/vnd.pagerduty+json;version=2',
      from: this.opts.fromEmail,
    }
  }
}

/** Render an investigation update into a PagerDuty note body (plain text). */
function renderNote(update: IncidentUpdate): string {
  const lines = [`cat-factory on-call: ${update.title}`, '', update.body]
  if (update.prUrl) lines.push('', `Suspect PR: ${update.prUrl}`)
  if (update.revertUrl) lines.push(`Proposed revert: ${update.revertUrl}`)
  return lines.join('\n')
}
