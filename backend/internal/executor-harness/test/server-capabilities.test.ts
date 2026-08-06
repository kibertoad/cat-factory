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
//
// Accepting a job STARTS one, which is the whole reason the handshake rides the acceptance, so
// every test here that accepts one also stops it, through the same `DELETE /jobs/{id}` a refusing
// dispatch uses. Leaving it would spawn a real agent CLI (with a bogus token) on whatever machine
// runs the suite and let it outlive the test.

let base: string

/** A body the harness accepts with no repo and no checkout, so the acceptance path needs no clone. */
const inlineJob = (jobId: string): Record<string, unknown> => ({
  kind: 'inline',
  jobId,
  harness: 'claude-code',
  subscriptionToken: 'tok',
  model: 'claude-sonnet',
  userPrompt: 'hello',
})

const post = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const stop = (jobId: string): Promise<Response> =>
  fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })

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
    const res = await post(inlineJob('job-capabilities'))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      jobId: 'job-capabilities',
      capabilities: HARNESS_BODY_CAPABILITIES,
    })
    // The job the assertion above just started, stopped before it can spawn anything real.
    expect((await stop('job-capabilities')).status).toBe(200)
  })

  it('does not report one on a REFUSED body', async () => {
    // A 400 never accepted a job, so there is no dispatch to hold to a handshake; answering with
    // one would invite a caller to read the refusal as a capability verdict.
    const res = await post({ kind: 'agent' })
    expect(res.status).toBe(400)
    expect(await res.json()).not.toHaveProperty('capabilities')
  })
})

describe('the harness stops one job on request', () => {
  it('answers with the state the job REACHED, not merely that it was signalled', async () => {
    // The counterpart of the handshake: a backend that refuses the body has already started an
    // agent. It reports "stopped" to a human on the strength of this answer alone, so the harness
    // waits for the job to settle rather than replying the moment the abort fires.
    await post(inlineJob('job-stop'))
    const res = await stop('job-stop')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ jobId: 'job-stop', state: 'failed' })

    // And the job really is terminal afterwards, which is what a caller is entitled to conclude.
    const view = await fetch(`${base}/jobs/job-stop`)
    expect(((await view.json()) as { state: string }).state).not.toBe('running')
  })

  it('is idempotent for an already-settled job', async () => {
    // A caller may retry; a second stop must not read as a failure to stop.
    await post(inlineJob('job-stop-twice'))
    expect((await stop('job-stop-twice')).status).toBe(200)
    const again = await stop('job-stop-twice')
    expect(again.status).toBe(200)
    expect(((await again.json()) as { state: string }).state).not.toBe('running')
  })

  it('404s an unknown job rather than reporting a stop it never performed', async () => {
    // Distinguishable from the 200 above on purpose: this is also what a caller addressing the
    // WRONG runner sees, and only one of those two facts means nothing is running.
    const res = await stop('job-that-never-existed')
    expect(res.status).toBe(404)
  })
})
