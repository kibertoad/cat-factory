import { describe, expect, it } from 'vitest'
import { base64ToBytes, toBase64 } from '../shared/base64.js'
import {
  clientCredentialsBody,
  mintLegacyBackstageToken,
  parseServiceCatalogAuth,
  readAccessToken,
  requiresResolvedBearer,
  serviceCatalogAuthHeaders,
} from './serviceCatalogAuth.js'

describe('serviceCatalogAuthHeaders', () => {
  it('sends nothing for an unauthenticated portal', () => {
    expect(serviceCatalogAuthHeaders({ mode: 'none' }, null)).toEqual({})
  })

  it('sends a static token as a bearer', () => {
    expect(serviceCatalogAuthHeaders({ mode: 'static-token', token: 't0k' }, null)).toEqual({
      authorization: 'Bearer t0k',
    })
  })

  it('sends basic credentials as UTF-8 base64', () => {
    // A byte-per-char encode would truncate the non-ASCII character to its low byte and produce a
    // credential that is wrong in a way no error names.
    const headers = serviceCatalogAuthHeaders(
      { mode: 'basic', username: 'reader', password: 'pä55' },
      null,
    )
    expect(headers.authorization).toBe(`Basic ${toBase64('reader:pä55')}`)
  })

  it('sends every named header, so a two-header service token arrives whole', () => {
    expect(
      serviceCatalogAuthHeaders(
        {
          mode: 'headers',
          headers: [
            { name: 'CF-Access-Client-Id', value: 'id' },
            { name: 'CF-Access-Client-Secret', value: 'secret' },
          ],
        },
        null,
      ),
    ).toEqual({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' })
  })

  it('refuses to build a bearer mode with no resolved token', () => {
    // Sending the request unauthenticated instead would come back as a rejected credential and
    // send the operator after the token they entered correctly.
    expect(() =>
      serviceCatalogAuthHeaders(
        {
          mode: 'oauth2-client-credentials' as const,
          tokenUrl: 'https://idp.example/token',
          clientId: 'c',
          clientSecret: 's',
        },
        null,
      ),
    ).toThrow(/not resolved/)
  })
})

describe('requiresResolvedBearer', () => {
  it('is true for exactly the two modes that need a round trip or a mint', () => {
    expect(requiresResolvedBearer('legacy-shared-secret')).toBe(true)
    expect(requiresResolvedBearer('oauth2-client-credentials')).toBe(true)
    expect(requiresResolvedBearer('static-token')).toBe(false)
    expect(requiresResolvedBearer('none')).toBe(false)
    expect(requiresResolvedBearer('basic')).toBe(false)
    expect(requiresResolvedBearer('headers')).toBe(false)
  })
})

describe('mintLegacyBackstageToken', () => {
  const secret = toBase64('a-32-byte-ish-shared-secret-value')

  it('signs an HS256 JWT the shared secret verifies', async () => {
    const token = await mintLegacyBackstageToken(secret, 1_700_000_000)
    const [header, payload, signature] = token.split('.')
    expect(JSON.parse(decodeSegment(header!))).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(decodeSegment(payload!))).toEqual({
      sub: 'backstage-server',
      iat: 1_700_000_000,
      exp: 1_700_000_600,
    })
    // Verified against the key the secret DECODES to, which is the whole point: signing with the
    // raw characters of a base64 secret produces a different key and a token that never verifies.
    const key = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(secret)!.slice().buffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const verified = await crypto.subtle.verify(
      'HMAC',
      key,
      base64ToBytes(signature!)!.slice().buffer,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(verified).toBe(true)
  })

  it('refuses a shared secret that is not base64 rather than guessing at its bytes', async () => {
    await expect(mintLegacyBackstageToken('not base64 !!!', 1)).rejects.toThrow(/must be base64/)
  })
})

describe('clientCredentialsBody', () => {
  it('omits the optional parameters an IdP does not want', () => {
    expect(clientCredentialsBody({ clientId: 'c', clientSecret: 's' })).toBe(
      'grant_type=client_credentials&client_id=c&client_secret=s',
    )
  })

  it('includes scope and audience when configured', () => {
    const body = clientCredentialsBody({
      clientId: 'c',
      clientSecret: 's',
      scope: 'catalog:read',
      audience: 'backstage',
    })
    expect(body).toContain('scope=catalog%3Aread')
    expect(body).toContain('audience=backstage')
  })
})

describe('readAccessToken', () => {
  it('reads the token', () => {
    expect(readAccessToken({ access_token: 'abc', token_type: 'Bearer' })).toBe('abc')
  })

  it('is null for a body that carries none', () => {
    expect(readAccessToken({ error: 'invalid_client' })).toBeNull()
    expect(readAccessToken('nope')).toBeNull()
  })
})

describe('parseServiceCatalogAuth', () => {
  it('reads a sealed bag back under its stored mode', () => {
    expect(
      parseServiceCatalogAuth(JSON.stringify({ mode: 'static-token', token: 't' }), 'static-token'),
    ).toEqual({
      mode: 'static-token',
      token: 't',
    })
  })

  it('needs no bag at all for the unauthenticated mode', () => {
    expect(parseServiceCatalogAuth('', 'none')).toEqual({ mode: 'none' })
  })

  it('refuses a bag that does not hold the mode the row declares', () => {
    // The column is what every management read and the request builder branch on, so a bag that
    // claims a different scheme is a corrupt row rather than a scheme to switch to.
    expect(() =>
      parseServiceCatalogAuth(
        JSON.stringify({ mode: 'basic', username: 'u', password: 'p' }),
        'static-token',
      ),
    ).toThrow(/does not hold a 'static-token' credential/)
  })

  it('refuses an unopenable bag', () => {
    expect(() => parseServiceCatalogAuth('{not json', 'static-token')).toThrow(/Re-enter/)
  })

  it('refuses a headers bag with no usable header', () => {
    expect(() =>
      parseServiceCatalogAuth(
        JSON.stringify({ mode: 'headers', headers: [{ name: 'X' }] }),
        'headers',
      ),
    ).toThrow(/does not hold a 'headers' credential/)
  })
})

/** Decode one base64URL JWT segment back to text. */
function decodeSegment(segment: string): string {
  return new TextDecoder().decode(base64ToBytes(segment)!)
}
