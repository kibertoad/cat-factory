import type { GroupCacheHandle, SsoDiscoveryDocument } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { OidcProviderDirectory, readProviderMetadata } from '../src/auth/oidc/discovery.js'

// Discovery is what makes ONE adapter serve every enterprise IdP, so its validation is where a
// misconfigured or hostile provider has to be caught — and its caching is what stops the key
// rotation every provider performs from becoming a login outage or a request amplifier.

const ISSUER = 'https://acme.okta.com/oauth2/default'

function metadataBody(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/v1/authorize`,
    token_endpoint: `${ISSUER}/v1/token`,
    jwks_uri: `${ISSUER}/v1/keys`,
    userinfo_endpoint: `${ISSUER}/v1/userinfo`,
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  }
}

describe('readProviderMetadata', () => {
  it('reads the fields the flow uses', () => {
    expect(readProviderMetadata(metadataBody(), ISSUER)).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/v1/authorize`,
      tokenEndpoint: `${ISSUER}/v1/token`,
      jwksUri: `${ISSUER}/v1/keys`,
      userinfoEndpoint: `${ISSUER}/v1/userinfo`,
      supportsPkceS256: true,
    })
  })

  it('reports a provider with no userinfo endpoint as having none, not as broken', () => {
    const metadata = readProviderMetadata(metadataBody({ userinfo_endpoint: undefined }), ISSUER)
    expect(metadata.userinfoEndpoint).toBeNull()
  })

  it('does not refuse a provider that omits the PKCE advertisement', () => {
    // We send PKCE regardless: an unaware provider ignores the parameters, whereas refusing on the
    // advertisement locks out providers that implement the RFC without announcing it.
    const metadata = readProviderMetadata(
      metadataBody({ code_challenge_methods_supported: undefined }),
      ISSUER,
    )
    expect(metadata.supportsPkceS256).toBe(false)
  })

  it('names every missing required field in one message', () => {
    expect(() => readProviderMetadata({ issuer: ISSUER }, ISSUER)).toThrowError(
      /authorization_endpoint, token_endpoint, jwks_uri/,
    )
  })

  it('REFUSES a document whose declared issuer is not the URL it came from', () => {
    // The security check: the discovered `issuer` becomes both what every ID token's `iss` is
    // compared against and half of the identity subject, so admitting a mismatch would let another
    // issuer's tokens sign in here.
    expect(() =>
      readProviderMetadata(metadataBody({ issuer: 'https://evil.example' }), ISSUER),
    ).toThrowError(/declares issuer/)
  })

  it('tolerates a trailing slash / well-known suffix difference on the issuer', () => {
    expect(readProviderMetadata(metadataBody({ issuer: `${ISSUER}/` }), ISSUER).issuer).toBe(
      `${ISSUER}/`,
    )
  })
})

/** A pass-through cache handle (the Worker's isolate-safe shape) that counts its loads. */
function passthroughCache(): GroupCacheHandle<SsoDiscoveryDocument> & { invalidations: number } {
  const handle = {
    invalidations: 0,
    get: async (_key: string, _group: string, load: () => Promise<SsoDiscoveryDocument>) => load(),
    invalidate: async () => {
      handle.invalidations += 1
    },
    invalidateGroup: async () => {},
    invalidateAll: async () => {},
  }
  return handle
}

function fakeIdp() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(metadataBody()), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/v1/keys')) {
      return new Response(JSON.stringify({ keys: [{ kid: 'k1', kty: 'RSA' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

describe('OidcProviderDirectory', () => {
  it('fetches the metadata and the key set together', async () => {
    const directory = new OidcProviderDirectory({ fetchImpl: fakeIdp(), now: () => 1_000 })
    const document = await directory.resolve(ISSUER)
    expect(document.metadata.issuer).toBe(ISSUER)
    expect(document.jwks.keys).toHaveLength(1)
    expect(document.fetchedAt).toBe(1_000)
  })

  it('surfaces an unreachable provider as a 503 naming the URL it tried', async () => {
    // The URL is operator-configured, never user input, so naming it IS the diagnostic — a bare
    // "unreachable" sends an operator to the wrong system first.
    const directory = new OidcProviderDirectory({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    await expect(directory.resolve(ISSUER)).rejects.toThrowError(
      /Could not reach the identity provider at .*openid-configuration/,
    )
  })

  it('refuses an empty key set rather than caching a provider nothing can verify against', async () => {
    const directory = new OidcProviderDirectory({
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith('/v1/keys')
          ? new Response(JSON.stringify({ keys: [] }))
          : new Response(JSON.stringify(metadataBody()))) as unknown as typeof fetch,
    })
    await expect(directory.resolve(ISSUER)).rejects.toThrowError(/contains no keys/)
  })

  it('refetches on an unknown key id once the rate limit has passed', async () => {
    const cache = passthroughCache()
    let now = 10_000
    const directory = new OidcProviderDirectory({ cache, fetchImpl: fakeIdp(), now: () => now })
    const stale = await directory.resolve(ISSUER)
    now += 61_000
    const refreshed = await directory.refreshForUnknownKey(ISSUER, stale)
    expect(cache.invalidations).toBe(1)
    expect(refreshed).not.toBe(stale)
  })

  it('returns the SAME document when a refetch would be too soon', async () => {
    // The amplification bound: a stream of tokens carrying junk `kid`s must not turn into a
    // request per token pointed at the IdP. The caller then fails verification on the stale keys,
    // which is a retryable login error rather than an outage we caused.
    const cache = passthroughCache()
    const directory = new OidcProviderDirectory({ cache, fetchImpl: fakeIdp(), now: () => 10_000 })
    const fresh = await directory.resolve(ISSUER)
    expect(await directory.refreshForUnknownKey(ISSUER, fresh)).toBe(fresh)
    expect(cache.invalidations).toBe(0)
  })
})
