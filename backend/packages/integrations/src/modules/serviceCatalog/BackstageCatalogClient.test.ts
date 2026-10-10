import { describe, expect, it } from 'vitest'
import { BackstageCatalogClient } from './BackstageCatalogClient.js'

// The WIRE half of the Backstage adapter, driven through an injected `fetch`. What these cover is
// what only the request/response layer can get wrong: how the two-request shape attributes a
// missing interface, and how an over-large answer is reported. The mapping rules live in
// `backstage-catalog.logic.test.ts`, which needs no transport at all.

const BASE = 'https://backstage.example.com'

/** A JSON response, optionally declaring a `content-length` larger than it carries. */
function json(body: unknown, declaredLength?: number): Response {
  const text = JSON.stringify(body)
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(declaredLength ? { 'content-length': String(declaredLength) } : {}),
    },
  })
}

const component = (name: string, providesApis: string[]) => ({
  kind: 'Component',
  metadata: { name },
  spec: { type: 'service', owner: 'group:default/payments', providesApis },
})

const apiEntity = (name: string) => ({
  kind: 'API',
  metadata: { name },
  spec: { type: 'openapi', definition: 'openapi: 3.0.0\npaths: {}\n' },
})

/**
 * A client whose `fetch` answers the listing with `entities` and the batched by-refs request with
 * `apis`, positionally against the refs it was asked for (which is how the vendor answers, and what
 * makes an unknown reference a `null` at a known index).
 */
function clientFor(options: {
  entities: unknown[]
  apis?: Record<string, unknown>
  declaredLength?: number
}) {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/by-query')) {
      return json({ items: options.entities, pageInfo: {} }, options.declaredLength)
    }
    const body = JSON.parse(String(init?.body)) as { entityRefs: string[] }
    return json(
      { items: body.entityRefs.map((ref) => options.apis?.[ref] ?? null) },
      options.declaredLength,
    )
  }
  return {
    calls,
    client: new BackstageCatalogClient({
      baseUrl: BASE,
      auth: { mode: 'none' },
      fetchImpl,
    }),
  }
}

const fetchOptions = { entityFilter: ['kind=component'], includeApis: true, maxServices: 200 }

describe('BackstageCatalogClient.fetchCatalog', () => {
  it('counts an unresolvable interface ONCE however many components declare it', async () => {
    // The number is the only evidence an operator has of how much of the estate is missing, so a
    // per-declaration tally (three providers of one absent interface reading as three losses)
    // overstates it.
    const { client } = clientFor({
      entities: [
        component('orders', ['api:default/shared']),
        component('billing', ['api:default/shared']),
        component('reporting', ['api:default/shared']),
      ],
      apis: {},
    })

    const fetched = await client.fetchCatalog(fetchOptions)

    expect(fetched.entries).toHaveLength(3)
    expect(fetched.skippedApis).toBe(1)
  })

  it('attaches one resolved interface to every provider, and counts no loss', async () => {
    const { client, calls } = clientFor({
      entities: [
        component('orders', ['api:default/shared']),
        component('billing', ['api:default/shared']),
      ],
      apis: { 'api:default/shared': apiEntity('shared') },
    })

    const fetched = await client.fetchCatalog(fetchOptions)

    expect(fetched.skippedApis).toBe(0)
    expect(fetched.entries.map((entry) => entry.apis.length)).toEqual([1, 1])
    // Two requests for the whole import, not one per service: the listing plus ONE batched
    // by-refs, and the shared reference asked for exactly once.
    expect(calls).toHaveLength(2)
  })

  it('refuses an over-large answer as OUR limit, naming what shrinks it', async () => {
    // Read with a truncating cap this would be cut mid-token and then reported as "the portal
    // answered with a body that is not JSON", blaming someone else's server for a ceiling here.
    const { client } = clientFor({
      entities: [component('orders', [])],
      declaredLength: 9_000_000,
    })

    await expect(client.fetchCatalog(fetchOptions)).rejects.toMatchObject({
      details: { reason: 'service_catalog_response_too_large' },
    })
    await expect(client.fetchCatalog(fetchOptions)).rejects.toThrow(/Lower the service cap/)
  })

  it('refuses a connection whose stored filter was lost rather than importing the estate', async () => {
    const { client, calls } = clientFor({ entities: [] })

    await expect(client.fetchCatalog({ ...fetchOptions, entityFilter: [] })).rejects.toMatchObject({
      details: { reason: 'service_catalog_filter_missing' },
    })
    // Refused BEFORE any request: an unfiltered listing is the whole organisation.
    expect(calls).toEqual([])
  })
})
