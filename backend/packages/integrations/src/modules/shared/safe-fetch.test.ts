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
    const res = await safeFetch('https://pool.test/api', {}, assertNotMetadata, makeError, 5, doFetch)
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
    const res = await safeFetch('https://pool.test/api', {}, assertNotMetadata, makeError, 5, doFetch)
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after too many redirects', async () => {
    const doFetch = vi.fn().mockResolvedValue(redirectTo('https://pool.test/loop'))
    await expect(
      safeFetch('https://pool.test/api', {}, assertNotMetadata, makeError, 2, doFetch),
    ).rejects.toThrow(/too many redirects/i)
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
