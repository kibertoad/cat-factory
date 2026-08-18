import { describe, expect, it, vi } from 'vitest'
import { IncidentIoEnrichmentProvider } from './IncidentIoEnrichmentProvider.js'

// incident.io publishes no create operation for incident updates at any version, so the
// investigation lands as an unassigned ACTION on the live incident. These pin the endpoint and
// the narrowing, because both are claims about a vendor's surface that nothing else can fail on.
describe('IncidentIoEnrichmentProvider', () => {
  const query = { workspaceId: 'ws', signalIds: ['mon-1'], since: 1_000 }
  const update = { title: 'Regression suspected', body: 'evidence', prUrl: 'https://pr' }

  function provider(handler: (url: string, init?: RequestInit) => Response) {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) })
      return handler(String(url), init)
    })
    return {
      calls,
      instance: new IncidentIoEnrichmentProvider({
        apiKey: 'key',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    }
  }

  const listing = (incidents: unknown[]) =>
    new Response(JSON.stringify({ incidents, pagination_meta: {} }), { status: 200 })

  const liveIncident = {
    id: 'inc-1',
    name: 'mon-1 error rate',
    created_at: new Date(5_000).toISOString(),
    incident_status: { category: 'live' },
  }

  it('records the investigation as an unassigned action on the matched incident', async () => {
    const { calls, instance } = provider((url) =>
      url.includes('/v2/actions') ? new Response('{}', { status: 201 }) : listing([liveIncident]),
    )

    await instance.enrich(query, update)

    const post = calls.find((c) => c.url.endsWith('/v2/actions'))
    expect(post).toBeDefined()
    expect(post!.init?.method).toBe('POST')
    const body = JSON.parse(String(post!.init?.body)) as Record<string, unknown>
    expect(body.incident_id).toBe('inc-1')
    expect(body.description).toContain('Regression suspected')
    expect(body).not.toHaveProperty('assignee_id')
  })

  it('narrows the incident list server-side by status category', async () => {
    const { calls, instance } = provider((url) =>
      url.includes('/v2/actions') ? new Response('{}', { status: 201 }) : listing([liveIncident]),
    )

    await instance.enrich(query, update)

    const list = new URL(calls[0]!.url)
    expect(list.searchParams.getAll('status_category[one_of]')).toEqual([
      'triage',
      'live',
      'paused',
    ])
    // One page is enough for a workspace with one live incident: the filter did the narrowing.
    expect(calls.filter((c) => c.url.includes('/v2/incidents'))).toHaveLength(1)
  })

  it('throws when the listing fails, so the caller reports it rather than reading it as "no incident"', async () => {
    const { instance } = provider(() => new Response('nope', { status: 429 }))

    await expect(instance.enrich(query, update)).rejects.toThrow(/HTTP 429/)
  })

  it('throws when the action create fails', async () => {
    const { instance } = provider((url) =>
      url.includes('/v2/actions') ? new Response('bad', { status: 422 }) : listing([liveIncident]),
    )

    await expect(instance.enrich(query, update)).rejects.toThrow(/HTTP 422/)
  })

  it('posts nothing when no live incident falls in the release window', async () => {
    const { calls, instance } = provider(() =>
      listing([{ ...liveIncident, created_at: new Date(0).toISOString() }]),
    )

    await instance.enrich(query, update)

    expect(calls.some((c) => c.url.includes('/v2/actions'))).toBe(false)
  })
})
