import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '@cat-factory/server'
import { makeNodeClientAddressResolver } from '../src/clientAddress.js'

// SEC-4: which header this facade may believe about the client. Node is behind an operator's
// proxy at most, never a known edge, so the answer is narrower than the Worker's and these
// tests exist to keep it that way.

async function resolve(
  auth: { trustProxyHeaders: boolean; trustedProxyHops: number },
  headers: Record<string, string>,
): Promise<string | undefined> {
  const resolveAddress = makeNodeClientAddressResolver(auth)
  const app = new Hono<AppEnv>()
  let seen: string | undefined
  app.get('/', (c) => {
    seen = resolveAddress(c)
    return c.text('ok')
  })
  await app.request('/', { headers })
  return seen
}

const TRUSTING = { trustProxyHeaders: true, trustedProxyHops: 1 }
const BARE = { trustProxyHeaders: false, trustedProxyHops: 1 }

describe('makeNodeClientAddressResolver', () => {
  it('ignores forwarded headers entirely on a bare deployment', async () => {
    // With no declared proxy the socket peer is the only trustworthy address; an in-process
    // request has none, so the honest answer is undefined (a shared throttle bucket).
    expect(await resolve(BARE, { 'x-forwarded-for': '10.0.0.1' })).toBeUndefined()
    expect(await resolve(BARE, { 'cf-connecting-ip': '10.0.0.1' })).toBeUndefined()
  })

  it('NEVER reads cf-connecting-ip, even when a proxy is trusted', async () => {
    // The regression this guards: nginx / Caddy / ALB rewrite x-forwarded-for and forward
    // every other header untouched, so believing a Cloudflare-specific header behind a
    // generic proxy left the throttle identity fully client-chosen — unlimited fresh buckets
    // for anyone rotating the value, and the ability to pin a victim's bucket.
    expect(await resolve(TRUSTING, { 'cf-connecting-ip': '203.0.113.9' })).toBeUndefined()
    // A spoofed cf-connecting-ip must not win over the real forwarded chain either.
    expect(
      await resolve(TRUSTING, {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '198.51.100.7',
      }),
    ).toBe('198.51.100.7')
  })

  it('takes the proxy-appended x-forwarded-for hop when a proxy is trusted', async () => {
    expect(await resolve(TRUSTING, { 'x-forwarded-for': 'spoofed, 198.51.100.7' })).toBe(
      '198.51.100.7',
    )
    expect(
      await resolve(
        { trustProxyHeaders: true, trustedProxyHops: 2 },
        { 'x-forwarded-for': 'spoofed, 198.51.100.7, 10.0.0.3' },
      ),
    ).toBe('198.51.100.7')
  })

  it('falls back to the peer when the chain does not match the declared topology', async () => {
    expect(
      await resolve(
        { trustProxyHeaders: true, trustedProxyHops: 3 },
        { 'x-forwarded-for': '198.51.100.7' },
      ),
    ).toBeUndefined()
  })
})
