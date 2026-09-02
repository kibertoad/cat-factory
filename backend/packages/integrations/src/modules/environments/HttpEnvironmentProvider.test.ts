import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentManifest } from '@cat-factory/kernel'
import { HttpEnvironmentProvider } from './HttpEnvironmentProvider.js'

// The manifest-driven provider's STATUS call, which is the one place a second look at an
// environment can overwrite what the first one captured.

const MANIFEST = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '/environments' },
  status: { method: 'GET' as const, pathTemplate: '/environments/{{provision.externalId}}' },
  teardown: { method: 'DELETE' as const, pathTemplate: '/environments/{{provision.externalId}}' },
  response: {
    externalIdPath: 'id',
    urlPath: 'url',
    statusPath: 'state',
    statusMap: [
      { from: 'pending', to: 'provisioning' as const },
      { from: 'running', to: 'ready' as const },
    ],
  },
} as unknown as EnvironmentManifest

/** Answers each call with the next scripted JSON body, recording the URLs it was asked for. */
function scriptedApi(bodies: readonly unknown[]) {
  const urls: string[] = []
  let call = 0
  const doFetch = vi.fn(async (url: string | URL) => {
    urls.push(String(url))
    const body = bodies[Math.min(call++, bodies.length - 1)]
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { urls, doFetch }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('HttpEnvironmentProvider.status', () => {
  it('states the WHOLE bag it knows, so a narrower answer cannot erase teardown state', async () => {
    // `fields` REPLACES the stored bag, and `mapResponse` builds one out of the two paths it
    // happened to resolve on THIS response. A status endpoint answering `{state}` (no id, no url:
    // the ordinary shape, since the id is in the request path rather than the body) therefore
    // stated an EMPTY bag, which is a statement, and it wiped `externalId` and `url`.
    //
    // The next call then interpolated an empty `{{provision.externalId}}`: `GET /environments/`
    // answered a collection listing, nothing mapped, the fallback status read `ready`, and the
    // environment looked healthy forever while `DELETE /environments/` could never reclaim it.
    const api = scriptedApi([{ state: 'running' }])
    globalThis.fetch = api.doFetch as unknown as typeof fetch
    const provider = new HttpEnvironmentProvider()

    const polled = await provider.status({
      manifest: MANIFEST,
      externalId: 'e1',
      provisionFields: { externalId: 'e1', url: 'https://pr-9.envs.test' },
      resolveSecret: () => undefined,
    })

    expect(api.urls).toEqual(['https://envs.test/api/environments/e1'])
    expect(polled.status).toBe('ready')
    expect(polled.fields).toEqual({ externalId: 'e1', url: 'https://pr-9.envs.test' })
  })

  it('lets a freshly mapped value WIN over the one it was handed', async () => {
    // Carrying the stored bag under the new one is not the same as merging back into it: a
    // provider that re-points an environment is still followed, and only a key this response said
    // nothing about is kept.
    const api = scriptedApi([{ id: 'e1', url: 'https://moved.envs.test', state: 'running' }])
    globalThis.fetch = api.doFetch as unknown as typeof fetch
    const provider = new HttpEnvironmentProvider()

    const polled = await provider.status({
      manifest: MANIFEST,
      externalId: 'e1',
      provisionFields: { externalId: 'e1', url: 'https://pr-9.envs.test', region: 'eu-west-1' },
      resolveSecret: () => undefined,
    })

    expect(polled.fields).toEqual({
      externalId: 'e1',
      url: 'https://moved.envs.test',
      region: 'eu-west-1',
    })
  })

  it('states NOTHING about the bag when there is no status endpoint to ask', async () => {
    // Nothing was asked, so this response makes no statement and the stored bag stays as it is.
    // Echoing the handed bag back would be indistinguishable from a statement.
    const provider = new HttpEnvironmentProvider()
    const { status: _status, ...withoutStatus } = MANIFEST as unknown as Record<string, unknown>

    const polled = await provider.status({
      manifest: withoutStatus as unknown as EnvironmentManifest,
      externalId: 'e1',
      provisionFields: { externalId: 'e1', url: 'https://pr-9.envs.test' },
      resolveSecret: () => undefined,
    })

    expect(polled.fields).toBeNull()
    expect(polled.status).toBe('ready')
  })
})
