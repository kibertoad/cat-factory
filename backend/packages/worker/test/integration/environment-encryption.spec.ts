import type { EnvironmentConnection, EnvironmentHandle } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeApp } from '../helpers'
import { buildContainer } from '../../src/infrastructure/container'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import {
  bearerManifest,
  readyEnvBody,
  recordingFetch,
  TEST_API_TOKEN,
} from './environment.fixtures'

afterEach(() => vi.unstubAllGlobals())

describe('environment credential encryption', () => {
  it('encrypts access creds at rest and round-trips them via the access endpoint', async () => {
    const stub = recordingFetch(() => ({ body: readyEnvBody() }))
    vi.stubGlobal('fetch', stub.fn)

    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/environments/connection`, {
      manifest: bearerManifest(),
      secrets: { API_TOKEN: TEST_API_TOKEN },
    })
    const provisioned = await app.call<EnvironmentHandle>(
      'POST',
      `/workspaces/${ws}/environments/provision`,
      { blockId: 'b' },
    )

    // The per-env access creds are ciphertext at rest.
    const row = await env.DB.prepare('SELECT access_cipher FROM environments WHERE id = ?')
      .bind(provisioned.body.id)
      .first<{ access_cipher: string | null }>()
    expect(row?.access_cipher).toBeTruthy()
    expect(row!.access_cipher!).not.toContain('env-access-tok')
    expect(row!.access_cipher!.startsWith('v1.')).toBe(true)

    // ...but decrypt back to the original creds on the access endpoint.
    const access = await app.call<EnvironmentHandle>(
      'GET',
      `/workspaces/${ws}/environments/${provisioned.body.id}/access`,
    )
    expect(access.body.access).toEqual({ scheme: 'bearer', token: 'env-access-tok' })
  })

  it('rotates the secret bundle via PUT', async () => {
    const stub = recordingFetch(() => ({ body: readyEnvBody() }))
    vi.stubGlobal('fetch', stub.fn)

    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/environments/connection`, {
      manifest: bearerManifest(),
      secrets: { API_TOKEN: TEST_API_TOKEN },
    })
    const rotated = await app.call<EnvironmentConnection>(
      'PUT',
      `/workspaces/${ws}/environments/connection/secrets`,
      { secrets: { API_TOKEN: 'rotated-token' } },
    )
    expect(rotated.status).toBe(200)

    await app.call('POST', `/workspaces/${ws}/environments/provision`, { blockId: 'b' })
    const call = stub.calls.find((c) => c.url === 'https://envs.test/api/environments')
    expect(call?.headers.authorization).toBe('Bearer rotated-token')
  })

  it('refuses to assemble the module without an encryption key', async () => {
    const withKey = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
    expect(withKey.environments).toBeDefined()

    const withoutKey = buildContainer(
      {
        ...env,
        ENVIRONMENTS_ENCRYPTION_KEY: undefined,
      } as typeof env,
      { agentExecutor: new FakeAgentExecutor() },
    )
    expect(withoutKey.environments).toBeUndefined()
  })
})
