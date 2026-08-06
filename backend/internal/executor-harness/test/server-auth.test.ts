import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The inbound shared-secret gate, with a secret actually configured.
//
// Its own file because `HARNESS_SHARED_SECRET` is read once at module load, so the gate can only be
// exercised by importing the server AFTER setting it — which the open-by-default fixtures cannot do.
//
// What makes it worth pinning now: `DELETE /jobs/{id}` is a KILL SWITCH. It exists so a backend
// that refused a job as blind can stop the agent it already started, and an unauthenticated one
// would let anyone who can reach the harness abort a run's work. The route is one line below the
// gate in `server.ts` and one line above it would compile, pass every other test, and ship.

process.env.HARNESS_SHARED_SECRET = 'test-secret'
const { server } = await import('../src/server.js')

let base: string

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  delete process.env.HARNESS_SHARED_SECRET
})

describe('the shared-secret gate', () => {
  it('refuses an unauthenticated job stop', async () => {
    const res = await fetch(`${base}/jobs/some-job`, { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('refuses an unauthenticated dispatch and poll', async () => {
    expect((await fetch(`${base}/jobs/some-job`)).status).toBe(401)
    const dispatch = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'inline' }),
    })
    expect(dispatch.status).toBe(401)
  })

  it('lets /health through, because a version/capability probe is not a secret', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })

  it('admits a request carrying the secret', async () => {
    // A 404 (no such job), not a 401: the gate passed and the route ran.
    const res = await fetch(`${base}/jobs/some-job`, {
      method: 'DELETE',
      headers: { 'x-harness-secret': 'test-secret' },
    })
    expect(res.status).toBe(404)
  })
})
