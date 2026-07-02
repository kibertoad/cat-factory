import { FakeAgentExecutor } from '@cat-factory/conformance'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'

// The public external API (`/api/v1`) over the real Hono app + real local D1, inside workerd:
// issue a key, run a public inline "initiative" pipeline headlessly, retrieve the DB-persisted
// result asynchronously, and prove the anchoring block never appears on the board. The Node facade
// asserts the repository + snapshot parity via the cross-runtime conformance suite.

describe('public API — break down an initiative', () => {
  it('issues a key, runs headlessly, retrieves the result, and hides the anchor block', async () => {
    const app = makeApp(new FakeAgentExecutor())
    const snapshot = await app.createWorkspace({ seed: true })
    const workspaceId = snapshot.workspace.id

    // Mint a public-API key via the session-authed management route (dev-open in tests).
    const created = await app.call<{ key: { id: string }; secret: string }>(
      'POST',
      `/workspaces/${workspaceId}/public-api-keys`,
      { label: 'external system' },
    )
    expect(created.status).toBe(201)
    const secret = created.body.secret
    expect(secret).toMatch(/^cf_live_pak_[0-9a-f]+\.[0-9a-f]+$/)

    const auth = { authorization: `Bearer ${secret}` }

    // A missing/invalid key is rejected.
    const noKey = await app.call('POST', '/api/v1/initiatives', {
      pipelineId: 'pl_initiative_breakdown',
      input: 'x',
    })
    expect(noKey.status).toBe(401)

    // Start an initiative breakdown.
    const started = await app.call<{ jobId: string; status: string }>(
      'POST',
      '/api/v1/initiatives',
      { pipelineId: 'pl_initiative_breakdown', input: 'Build a cat feeder service' },
      auth,
    )
    expect(started.status).toBe(202)
    const jobId = started.body.jobId
    expect(started.body.status).toBe('running')

    // Drive the durable run to completion (the Workflows driver does this in production).
    await app.drive(workspaceId)

    // The persisted result is retrievable by job id.
    const job = await app.call<{ status: string; result: { output: string } | null }>(
      'GET',
      `/api/v1/jobs/${jobId}`,
      undefined,
      auth,
    )
    expect(job.status).toBe(200)
    expect(job.body.status).toBe('succeeded')
    expect(job.body.result?.output).toBeTruthy()

    // The headless anchor block is excluded from the board snapshot.
    const board = await app.call<{ blocks: { title: string; internal?: boolean }[] }>(
      'GET',
      `/workspaces/${workspaceId}`,
    )
    expect(board.status).toBe(200)
    expect(board.body.blocks.some((b) => b.internal)).toBe(false)
    expect(board.body.blocks.some((b) => b.title === 'Build a cat feeder service')).toBe(false)

    // A non-public pipeline id is refused.
    const nonPublic = await app.call(
      'POST',
      '/api/v1/initiatives',
      { pipelineId: 'pl_blueprint', input: 'x' },
      auth,
    )
    expect(nonPublic.status).toBe(400)

    // After revoking the key it no longer authenticates.
    const revoked = await app.call(
      'DELETE',
      `/workspaces/${workspaceId}/public-api-keys/${created.body.key.id}`,
    )
    expect(revoked.status).toBe(204)
    const afterRevoke = await app.call('GET', `/api/v1/jobs/${jobId}`, undefined, auth)
    expect(afterRevoke.status).toBe(401)
  })
})
