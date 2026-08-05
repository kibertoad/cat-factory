import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HARNESS_BODY_CAPABILITIES } from '../src/agent-capabilities.js'
import { server } from '../src/server.js'

// The capability handshake as the backend actually reads it: off the wire.
//
// The list itself is pinned against kernel by the conformity suite; what is asserted here is that
// the two RESPONSES a backend can see actually carry it. The acceptance body is the load-bearing
// one (the only moment a dispatch can still refuse a blind run), and a change that reported
// only on `/health` would look correct in review while leaving the pool case (whose control plane
// never probes health) exactly as blind as before.

let base: string

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe('the harness reports which body capabilities it parses', () => {
  it('on /health, unauthenticated like the rest of it', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'ok',
      capabilities: HARNESS_BODY_CAPABILITIES,
    })
  })

  it('on the job ACCEPTANCE, which is where a dispatch can still act on it', async () => {
    // An `inline` job: it parses with no repo and no checkout, so this exercises the acceptance
    // path without a clone. Its background run fails on the missing CLI, which is irrelevant:
    // the 202 is written before the handler is ever entered.
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'inline',
        jobId: 'job-capabilities',
        harness: 'claude-code',
        subscriptionToken: 'tok',
        model: 'claude-sonnet',
        userPrompt: 'hello',
      }),
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      jobId: 'job-capabilities',
      capabilities: HARNESS_BODY_CAPABILITIES,
    })
  })

  it('does not report one on a REFUSED body', async () => {
    // A 400 never accepted a job, so there is no dispatch to hold to a handshake; answering with
    // one would invite a caller to read the refusal as a capability verdict.
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'agent' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).not.toHaveProperty('capabilities')
  })
})
