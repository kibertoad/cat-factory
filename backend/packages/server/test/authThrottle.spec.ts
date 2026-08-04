import type { AuthAttemptRecord, AuthAttemptRepository } from '@cat-factory/kernel'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { passwordAttemptLimited } from '../src/modules/auth/authThrottle.js'

// The password throttle (SEC-4): the durable ledger is the authoritative cross-replica
// window (per-key burst cap + per-IP stuffing aggregate) and the in-process Map is the
// store-outage backstop. The throttle keys on whatever the FACADE resolved as the client
// address (see each facade's `resolveClientAddress`; the header choice is deliberately not
// made here), normalising it so a port or an IPv6 interface half cannot mint fresh buckets.
// Buckets are unique per test because the backstop Map is module-global.

/** An in-memory AuthAttemptRepository with the port's exact window semantics. */
function fakeStore(): AuthAttemptRepository & { rows: AuthAttemptRecord[] } {
  const rows: AuthAttemptRecord[] = []
  return {
    rows,
    record: async (attempt) => {
      rows.push(attempt)
    },
    countByKeySince: async (key, since) =>
      rows.filter((r) => r.key === key && r.at >= since).length,
    countByIpSince: async (ip, since) => rows.filter((r) => r.ip === ip && r.at >= since).length,
    deleteOlderThan: async () => 0,
  }
}

function makeApp(opts: {
  store?: AuthAttemptRepository
  /** What the facade resolves as the client address (its header policy lives there). */
  socketAddress?: string
  /** Per-request override, for asserting two clients are separate buckets. */
  addressHeader?: string
}) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      config: { auth: { trustProxyHeaders: false, trustedProxyHops: 1 } },
      ...(opts.store ? { authAttemptRepository: opts.store } : {}),
      resolveClientAddress: (ctx: Context<AppEnv>) =>
        (opts.addressHeader ? ctx.req.header(opts.addressHeader) : undefined) ?? opts.socketAddress,
    } as unknown as ServerContainer)
    await next()
  })
  app.post('/try/:bucket', async (c) =>
    c.json({ limited: await passwordAttemptLimited(c, c.req.param('bucket')) }),
  )
  return app
}

async function attempt(
  app: Hono<AppEnv>,
  bucket: string,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const res = await app.request(`/try/${bucket}`, { method: 'POST', headers })
  return ((await res.json()) as { limited: boolean }).limited
}

let seq = 0
const unique = (label: string) => `${label}-${Date.now()}-${(seq += 1)}`

describe('passwordAttemptLimited', () => {
  it('limits the 11th attempt for one ip+bucket through the durable store', async () => {
    const app = makeApp({ store: fakeStore(), socketAddress: unique('sock') })
    const bucket = unique('mail')
    for (let i = 0; i < 10; i += 1) {
      expect(await attempt(app, bucket), `attempt ${i + 1}`).toBe(false)
    }
    expect(await attempt(app, bucket)).toBe(true)
  })

  it('trips the per-IP aggregate across many buckets (credential stuffing)', async () => {
    // One password sprayed across many emails: every per-key bucket stays at 1, only
    // the per-IP aggregate can see the sweep.
    const app = makeApp({ store: fakeStore(), socketAddress: unique('sock') })
    let limited = false
    for (let i = 0; i < 51 && !limited; i += 1) {
      limited = await attempt(app, unique(`spray-${i}`))
    }
    expect(limited).toBe(true)
  })

  it('keys on the address the facade resolved, so header spoofing changes nothing', async () => {
    // The throttle no longer looks at headers at all: an attacker rotating x-forwarded-for
    // (or cf-connecting-ip) cannot mint fresh buckets, because only the facade decides what
    // the client address is and this facade resolved a fixed peer.
    const app = makeApp({ store: fakeStore(), socketAddress: unique('sock') })
    const bucket = unique('mail')
    let limited = false
    for (let i = 0; i < 11; i += 1) {
      limited = await attempt(app, bucket, {
        'x-forwarded-for': `10.0.0.${i}`,
        'cf-connecting-ip': `10.1.0.${i}`,
      })
    }
    expect(limited).toBe(true)
  })

  it('separates two clients the facade resolves differently', async () => {
    const app = makeApp({ store: fakeStore(), addressHeader: 'x-test-client' })
    const bucket = unique('mail')
    const a = '198.51.100.7'
    for (let i = 0; i < 11; i += 1) await attempt(app, bucket, { 'x-test-client': a })
    expect(await attempt(app, bucket, { 'x-test-client': a })).toBe(true)
    // A different client against the same bucket is not limited by a's burst.
    expect(await attempt(app, bucket, { 'x-test-client': '203.0.113.4' })).toBe(false)
  })

  it('normalises the resolved address, so a port or IPv6 suffix is not a fresh bucket', async () => {
    // A port-appending proxy would otherwise mint a bucket per connection, and an attacker
    // holding a /64 would have 2^64 of them.
    const app = makeApp({ store: fakeStore(), addressHeader: 'x-test-client' })
    const bucket = unique('mail')
    let limited = false
    for (let i = 0; i < 11; i += 1) {
      limited = await attempt(app, bucket, { 'x-test-client': `198.51.100.7:${5000 + i}` })
    }
    expect(limited).toBe(true)

    const v6 = makeApp({ store: fakeStore(), addressHeader: 'x-test-client' })
    const v6Bucket = unique('mail')
    let v6Limited = false
    for (let i = 0; i < 11; i += 1) {
      v6Limited = await attempt(v6, v6Bucket, { 'x-test-client': `2001:db8:1:2::${i + 1}` })
    }
    expect(v6Limited).toBe(true)
  })

  it('falls back to the in-process backstop when the store errors (never fails open)', async () => {
    const broken: AuthAttemptRepository = {
      record: async () => {
        throw new Error('db down')
      },
      countByKeySince: async () => 0,
      countByIpSince: async () => 0,
      deleteOlderThan: async () => 0,
    }
    const app = makeApp({ store: broken, socketAddress: unique('sock') })
    const bucket = unique('mail')
    let limited = false
    for (let i = 0; i < 11; i += 1) {
      limited = await attempt(app, bucket)
    }
    expect(limited).toBe(true)
  })

  it('still limits with no durable store wired (the old speed bump)', async () => {
    const app = makeApp({ socketAddress: unique('sock') })
    const bucket = unique('mail')
    let limited = false
    for (let i = 0; i < 11; i += 1) {
      limited = await attempt(app, bucket)
    }
    expect(limited).toBe(true)
  })
})
