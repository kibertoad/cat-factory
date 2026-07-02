import { describe, expect, it, vi } from 'vitest'
import { readCappedText, safeFetch } from './safe-fetch.js'

// The shared SSRF-safe fetch used by the policy-based providers (environments +
// runner-pool). The critical invariant is that the `assertSafe` guard runs on EVERY
// redirect hop, so a permitted first hop can't chase a secret-bearing body to an
// internal target.

const makeError = (status: number, message: string) => new Error(`${message} (HTTP ${status})`)
const ok = () => new Response('{"ok":true}', { status: 200 })
const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } })

/** Reject the cloud-metadata endpoint, allow everything else (stand-in for the real guard). */
function assertNotMetadata(url: string): void {
  if (new URL(url).hostname === '169.254.169.254') {
    throw new Error('blocked: metadata host')
  }
}

describe('safeFetch redirect revalidation', () => {
  it('validates the initial URL and returns a non-redirect response', async () => {
    const doFetch = vi.fn().mockResolvedValue(ok())
    const res = await safeFetch(
      'https://pool.test/api',
      {},
      assertNotMetadata,
      makeError,
      5,
      doFetch,
    )
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(1)
    // Redirects are handled manually so a 3xx is observed, not auto-followed.
    expect(doFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('re-runs the guard on a redirect and blocks a hop to the metadata endpoint', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data'))
    await expect(
      safeFetch('https://pool.test/api', {}, assertNotMetadata, makeError, 5, doFetch),
    ).rejects.toThrow(/blocked: metadata host/)
    // The denied target is never fetched — the body can't leak.
    expect(doFetch).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to another allowed host', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://pool2.test/api'))
      .mockResolvedValueOnce(ok())
    const res = await safeFetch(
      'https://pool.test/api',
      {},
      assertNotMetadata,
      makeError,
      5,
      doFetch,
    )
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after too many redirects', async () => {
    const doFetch = vi.fn().mockResolvedValue(redirectTo('https://pool.test/loop'))
    await expect(
      safeFetch('https://pool.test/api', {}, assertNotMetadata, makeError, 2, doFetch),
    ).rejects.toThrow(/too many redirects/i)
  })

  it('strips the body + credential headers on a CROSS-origin redirect', async () => {
    // A permitted first hop can 302 to another host that also passes the SSRF guard (any
    // public https host). The secret dispatch body + Authorization header must NOT be
    // forwarded there, so both are dropped on the cross-origin hop (stricter than stock
    // fetch, which keeps a 307/308 body — our bodies carry credentials).
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://attacker.test/collect'))
      .mockResolvedValueOnce(ok())
    const res = await safeFetch(
      'https://pool.test/api',
      { method: 'POST', body: 'secret-dispatch-token', headers: { authorization: 'Bearer sk-x' } },
      assertNotMetadata,
      makeError,
      5,
      doFetch,
    )
    expect(res.status).toBe(200)
    const crossOriginInit = doFetch.mock.calls[1]?.[1] as RequestInit
    expect(crossOriginInit.body).toBeUndefined()
    expect(new Headers(crossOriginInit.headers).get('authorization')).toBeNull()
  })

  it('keeps the body + headers on a SAME-origin redirect', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://pool.test/api/v2'))
      .mockResolvedValueOnce(ok())
    await safeFetch(
      'https://pool.test/api',
      { method: 'POST', body: 'payload', headers: { authorization: 'Bearer k' } },
      assertNotMetadata,
      makeError,
      5,
      doFetch,
    )
    const sameOriginInit = doFetch.mock.calls[1]?.[1] as RequestInit
    expect(sameOriginInit.body).toBe('payload')
    expect(new Headers(sameOriginInit.headers).get('authorization')).toBe('Bearer k')
  })
})

describe('readCappedText', () => {
  it('rejects a response whose declared Content-Length exceeds the cap', async () => {
    const res = new Response('x'.repeat(100), { headers: { 'content-length': '100' } })
    await expect(readCappedText(res, 10, makeError)).rejects.toThrow(/response too large/i)
  })

  it('rejects a streamed body that exceeds the cap', async () => {
    const res = new Response('x'.repeat(100))
    await expect(readCappedText(res, 10, makeError)).rejects.toThrow(/response too large/i)
  })

  it('truncates instead of throwing when throwOnOverflow is false', async () => {
    const res = new Response('x'.repeat(100))
    const text = await readCappedText(res, 10, makeError, false)
    expect(text.length).toBe(10)
  })
})
