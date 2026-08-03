import type { AuthAttemptRecord, AuthAttemptRepository } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { passwordAttemptLimited } from '../src/modules/auth/authThrottle.js'

// The password throttle (SEC-4): the durable ledger is the authoritative cross-replica
// window (per-key burst cap + per-IP stuffing aggregate), the in-process Map is the
// store-outage backstop, and forwarded headers are trusted only behind the explicit
// proxy-trust flag. Buckets are unique per test because the backstop Map is module-global.

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
  trustProxy?: boolean
  socketAddress?: string
}) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      config: { auth: { trustProxyHeaders: opts.trustProxy ?? false } },
      ...(opts.store ? { authAttemptRepository: opts.store } : {}),
      resolveClientAddress: () => opts.socketAddress,
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

  it('ignores forwarded headers unless the proxy-trust flag is on', async () => {
    // An attacker rotating x-forwarded-for must not mint fresh buckets: with the flag
    // off the socket peer is the identity, so the rotation changes nothing.
    const app = makeApp({ store: fakeStore(), trustProxy: false, socketAddress: unique('sock') })
    const bucket = unique('mail')
    let limited = false
    for (let i = 0; i < 11; i += 1) {
      limited = await attempt(app, bucket, { 'x-forwarded-for': `10.0.0.${i}` })
    }
    expect(limited).toBe(true)
  })

  it('uses the forwarded client IP when the proxy-trust flag is on', async () => {
    // Behind a trusted proxy every request shares one socket peer; the forwarded header
    // is what separates two clients' buckets.
    const app = makeApp({ store: fakeStore(), trustProxy: true, socketAddress: 'proxy-peer' })
    const bucket = unique('mail')
    const a = unique('1.1.1')
    for (let i = 0; i < 11; i += 1) {
      await attempt(app, bucket, { 'cf-connecting-ip': a })
    }
    expect(await attempt(app, bucket, { 'cf-connecting-ip': a })).toBe(true)
    // A different client against the same bucket is not limited by a's burst.
    expect(await attempt(app, bucket, { 'cf-connecting-ip': unique('2.2.2') })).toBe(false)
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
