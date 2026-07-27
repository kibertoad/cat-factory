import { buildHonoRoute } from '@toad-contracts/hono'
import { defineApiContract } from '@toad-contracts/valibot'
import { Hono } from 'hono'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { optionalJsonBody } from './optionalJsonBody.js'

// A contract-declared body schema makes the transport REQUIRE a body, even when every field in it
// is optional: the validator reads `c.req.json()` before the schema is consulted, and that throws
// on an absent body. These tests pin that adding an optional field to a previously body-less route
// keeps body-less callers working.

const contract = defineApiContract({
  method: 'post',
  pathResolver: () => '/thing',
  requestBodySchema: v.object({ tag: v.optional(v.picklist(['a', 'b'])) }),
  responsesByStatusCode: { 200: v.object({ tag: v.optional(v.string()) }) },
})

function makeApp(withMiddleware: boolean): Hono {
  const app = new Hono()
  app.onError((error, c) => c.json({ error: String(error) }, 400))
  if (withMiddleware) app.use('/thing', optionalJsonBody)
  buildHonoRoute(app, contract, (c) => c.json({ tag: c.req.valid('json').tag }, 200))
  return app
}

const post = (app: Hono, init?: RequestInit) =>
  app.request('/thing', { method: 'POST', ...init } as RequestInit)

describe('optionalJsonBody', () => {
  it('lets a request with NO body through as an empty object', async () => {
    const res = await post(makeApp(true))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('lets a request that declares an empty body through too', async () => {
    // A client sending `Content-Length: 0` hands over a non-null but empty stream, which
    // `json()` rejects identically to no body at all.
    const res = await post(makeApp(true), { headers: { 'content-length': '0' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('leaves a real body untouched', async () => {
    const res = await post(makeApp(true), {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'b' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tag: 'b' })
  })

  it('still rejects a body that violates the schema', async () => {
    // The middleware normalises ABSENCE only; it must not weaken validation of what is sent.
    const res = await post(makeApp(true), {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('documents the failure it exists to prevent: no middleware, no body ⇒ 400', async () => {
    const res = await post(makeApp(false))
    expect(res.status).toBe(400)
  })
})
