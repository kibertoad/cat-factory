import type {
  IncidentEnrichmentProvider,
  IncidentMatchQuery,
  IncidentUpdate,
} from '@cat-factory/kernel'
import { pickIncidentToEnrich } from '../incident/incident.logic.js'

// Enriches (does NOT create) an incident.io incident already opened from the same Datadog
// monitors/SLOs the post-release-health gate watches. On a regression the on-call agent's
// investigation is posted onto that incident so responders see "which PR, what evidence,
// recommended action". Best-effort: no matching live incident → no-op. NOT a notification
// channel — incident.io already alerted off the same signals.
//
// WHERE the investigation lands is a decision, not a lookup. incident.io publishes no create
// operation for incident updates at any version (this file used to POST
// `/v2/incident_updates`, which exists only as a GET, so the enrichment had never once
// worked). Of what it does publish, `POST /v2/actions` is the only fit: an action is work
// tracked ON the live incident, it takes Markdown, it is left unassigned so it pages nobody,
// and it stays inside the incident. The two neighbours are both wrong on purpose —
// `status-page-incident-updates-v2/create` publishes to the customer-facing status page,
// which is the re-alerting this integration exists not to do, and `follow-ups-v2/create`
// files post-incident work rather than annotating the incident being fought.

type FetchLike = typeof fetch

/**
 * The status categories an incident can be in and still be worth annotating. incident.io
 * publishes eight (`triage`, `live`, `learning`, `paused`, `closed`, `declined`, `canceled`,
 * `merged`); these are the ones a responder is still working.
 */
const ACTIVE_STATUS_CATEGORIES = ['triage', 'live', 'paused'] as const

/** Whether a listed incident is in one of {@link ACTIVE_STATUS_CATEGORIES}. */
function isActiveCategory(category: string | undefined): boolean {
  return (
    category === undefined || (ACTIVE_STATUS_CATEGORIES as readonly string[]).includes(category)
  )
}

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
   * the window — and record the investigation as an unassigned action on it. No-op when
   * none matches.
   */
  async enrich(query: IncidentMatchQuery, update: IncidentUpdate): Promise<void> {
    const incident = await this.findActiveIncident(query)
    if (!incident) return
    const res = await this.fetchImpl(`${this.apiBase}/v2/actions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        incident_id: incident.id,
        // `description` is the action's only text field and renders Markdown. No
        // `assignee_id`: an unassigned action is a note responders pick up, where assigning
        // one to whoever holds the API key would read as a page.
        description: renderUpdate(update),
      }),
    })
    if (!res.ok) {
      throw new Error(`incident.io action create failed: HTTP ${res.status}`)
    }
  }

  private async findActiveIncident(query: IncidentMatchQuery): Promise<IoIncident | null> {
    // The narrowing IS server-side: `status_category[one_of]` is a documented filter operator,
    // and it is what an older comment here was looking for when it concluded (wrongly) that the
    // `status` filter's workspace-specific ids were the only option and paged through eight
    // pages to filter in memory. `filter_mode` defaults to `all`, and the default sort is
    // newest-first, so the live incidents we want are on the first page in every realistic
    // workspace. The cursor walk stays, bounded, for the workspace whose live set is larger
    // than one page.
    const live: IoIncident[] = []
    let after: string | undefined
    for (let page = 0; page < 4; page++) {
      const params = new URLSearchParams({ page_size: '50' })
      for (const category of ACTIVE_STATUS_CATEGORIES)
        params.append('status_category[one_of]', category)
      if (after) params.set('after', after)
      const res = await this.fetchImpl(`${this.apiBase}/v2/incidents?${params.toString()}`, {
        method: 'GET',
        headers: this.headers(),
      })
      // Throw rather than return an empty match: an unreachable or refusing incident.io and a
      // workspace with no live incident are opposite facts, and the caller's `runBestEffort`
      // is what turns this into one named warning instead of a silent no-op.
      if (!res.ok) {
        throw new Error(`incident.io incident list failed: HTTP ${res.status}`)
      }
      const data = (await res.json()) as {
        incidents?: IoIncident[]
        pagination_meta?: { after?: string | null }
      }
      const batch = data.incidents ?? []
      // Two things the filter cannot do. `since` is a release marker rather than a status, and
      // the pick below is by recency, so an incident older than the release must not win it.
      // And the category is re-read off each row against the SAME list the filter was built
      // from: a server that ignored an unrecognised parameter would otherwise hand us a closed
      // incident to annotate, and one list checked at both ends is not two rules.
      for (const i of batch) {
        if (!isActiveCategory(i.incident_status?.category)) continue
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
