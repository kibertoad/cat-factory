import type { RunnerPoolConnection } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'
import { bearerRunnerManifest, RUNNER_API_TOKEN } from './runner-pool.fixtures'

describe('runner pool registration', () => {
  it('stores the secret bundle encrypted and exposes only safe metadata', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    const registered = await app.call<RunnerPoolConnection>(
      'POST',
      `/workspaces/${ws}/runner-pool/connection`,
      { manifest: bearerRunnerManifest(), secrets: { API_TOKEN: RUNNER_API_TOKEN } },
    )
    expect(registered.status).toBe(201)
    expect(registered.body.providerId).toBe('acme-pool')
    expect(registered.body.secretKeys).toEqual(['API_TOKEN'])

    const got = await app.call<{ connection: RunnerPoolConnection | null }>(
      'GET',
      `/workspaces/${ws}/runner-pool/connection`,
    )
    expect(got.body.connection?.secretKeys).toEqual(['API_TOKEN'])
    // The token value is never echoed on the wire.
    expect(JSON.stringify(got.body)).not.toContain(RUNNER_API_TOKEN)

    // The secret is encrypted at rest: the raw D1 cell holds no plaintext token.
    const row = await env.DB.prepare(
      'SELECT secrets_cipher FROM runner_pool_connections WHERE workspace_id = ?',
    )
      .bind(ws)
      .first<{ secrets_cipher: string }>()
    expect(row?.secrets_cipher).toBeTruthy()
    expect(row!.secrets_cipher).not.toContain(RUNNER_API_TOKEN)
    expect(row!.secrets_cipher.startsWith('v1.')).toBe(true)
  })

  it('rejects an internal base URL (SSRF guard)', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call('POST', `/workspaces/${workspace.id}/runner-pool/connection`, {
      manifest: bearerRunnerManifest({ baseUrl: 'https://localhost/api' }),
      secrets: { API_TOKEN: RUNNER_API_TOKEN },
    })
    expect(res.status).toBe(422)
  })

  it('rejects a manifest whose secret refs are not all supplied', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call('POST', `/workspaces/${workspace.id}/runner-pool/connection`, {
      manifest: bearerRunnerManifest(),
      secrets: {},
    })
    expect(res.status).toBe(422)
  })

  it('unregisters the pool (tombstones the binding)', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/runner-pool/connection`, {
      manifest: bearerRunnerManifest(),
      secrets: { API_TOKEN: RUNNER_API_TOKEN },
    })
    const del = await app.call('DELETE', `/workspaces/${ws}/runner-pool/connection`)
    expect(del.status).toBe(204)
    const got = await app.call<{ connection: RunnerPoolConnection | null }>(
      'GET',
      `/workspaces/${ws}/runner-pool/connection`,
    )
    expect(got.body.connection).toBeNull()
  })
})
