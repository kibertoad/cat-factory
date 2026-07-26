import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../http/env.js'
import { webhookBodyLimit } from './bodyLimit.js'

// SEC-9: the public, unauthenticated webhook receivers buffer the whole body (HMAC-over-body
// verification needs it) BEFORE the signature is checked, so an anonymous caller could otherwise
// pin memory up to the platform request limit. `webhookBodyLimit` caps that. The real routes use
// the 25 MB default; here we drive a tiny cap so the assertion stays cheap.
describe('webhookBodyLimit (SEC-9)', () => {
  const app = new Hono<AppEnv>()
  app.post('/w', webhookBodyLimit(8), (c) => c.text('ok'))

  it('accepts a body within the cap', async () => {
    const res = await app.request('/w', { method: 'POST', body: 'hello' })
    expect(res.status).toBe(200)
  })

  it('rejects an over-cap body with 413', async () => {
    const res = await app.request('/w', { method: 'POST', body: 'way too many bytes here' })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: { code: 'too_large' } })
  })
})
