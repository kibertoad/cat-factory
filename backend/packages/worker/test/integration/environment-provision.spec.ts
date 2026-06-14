import type { EnvironmentHandle, EnvironmentManifest } from '@cat-factory/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeApp } from '../helpers'
import {
  bearerManifest,
  readyEnvBody,
  recordingFetch,
  TEST_API_TOKEN,
  type CapturedRequest,
} from './environment.fixtures'

/** Stub `fetch` so it serves the OAuth token endpoint and the provision call. */
function installProvider() {
  const stub = recordingFetch((req: CapturedRequest) => {
    if (req.url.startsWith('https://auth.test/token')) {
      return { body: { access_token: 'oauth-tok', expires_in: 3600 } }
    }
    return { body: readyEnvBody() }
  })
  vi.stubGlobal('fetch', stub.fn)
  return stub
}

afterEach(() => vi.unstubAllGlobals())

describe('environment provisioning', () => {
  it('maps the provider response onto a canonical handle', async () => {
    const stub = installProvider()
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
      { blockId: 'block-1' },
    )
    expect(provisioned.status).toBe(201)
    expect(provisioned.body.url).toBe('https://env-1.envs.test')
    expect(provisioned.body.status).toBe('ready')
    expect(provisioned.body.externalId).toBe('env-1')
    expect(provisioned.body.expiresAt).toBeTruthy()
    // The list/handle responses never carry decrypted creds.
    expect(provisioned.body.access).toBeUndefined()

    // The provision call interpolated the input and authenticated as configured.
    const call = stub.calls.find((c) => c.url === 'https://envs.test/api/environments')
    expect(call?.method).toBe('POST')
    expect(call?.headers.authorization).toBe(`Bearer ${TEST_API_TOKEN}`)
    expect(call?.body).toBe('{"ref":"block-1"}')

    // The dedicated access endpoint returns the decrypted per-env creds.
    const access = await app.call<EnvironmentHandle>(
      'GET',
      `/workspaces/${ws}/environments/${provisioned.body.id}/access`,
    )
    expect(access.body.access).toEqual({ scheme: 'bearer', token: 'env-access-tok' })
  })

  const authCases: {
    name: string
    auth: EnvironmentManifest['auth']
    secrets: Record<string, string>
    assert: (call: CapturedRequest) => void
  }[] = [
    {
      name: 'bearer',
      auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
      secrets: { API_TOKEN: TEST_API_TOKEN },
      assert: (c) => expect(c.headers.authorization).toBe(`Bearer ${TEST_API_TOKEN}`),
    },
    {
      name: 'api_key',
      auth: {
        type: 'api_key',
        headerName: 'X-Api-Key',
        secretRef: { key: 'API_TOKEN' },
        valuePrefix: 'Token ',
      },
      secrets: { API_TOKEN: TEST_API_TOKEN },
      assert: (c) => expect(c.headers['x-api-key']).toBe(`Token ${TEST_API_TOKEN}`),
    },
    {
      name: 'basic',
      auth: {
        type: 'basic',
        usernameSecretRef: { key: 'USER' },
        passwordSecretRef: { key: 'PASS' },
      },
      secrets: { USER: 'alice', PASS: 'pw' },
      assert: (c) => expect(c.headers.authorization).toBe(`Basic ${btoa('alice:pw')}`),
    },
    {
      name: 'custom_headers',
      auth: {
        type: 'custom_headers',
        headers: [{ name: 'X-Token', secretRef: { key: 'API_TOKEN' } }],
      },
      secrets: { API_TOKEN: TEST_API_TOKEN },
      assert: (c) => expect(c.headers['x-token']).toBe(TEST_API_TOKEN),
    },
    {
      name: 'oauth2_client_credentials',
      auth: {
        type: 'oauth2_client_credentials',
        tokenUrl: 'https://auth.test/token',
        clientIdSecretRef: { key: 'CID' },
        clientSecretSecretRef: { key: 'CSEC' },
      },
      secrets: { CID: 'cid', CSEC: 'csec' },
      assert: (c) => expect(c.headers.authorization).toBe('Bearer oauth-tok'),
    },
  ]

  it.each(authCases)(
    'authenticates the provider call via $name',
    async ({ auth, secrets, assert }) => {
      const stub = installProvider()
      const app = makeApp()
      const { workspace } = await app.createWorkspace({ seed: false })
      const ws = workspace.id

      await app.call('POST', `/workspaces/${ws}/environments/connection`, {
        manifest: bearerManifest({ auth }),
        secrets,
      })
      await app.call('POST', `/workspaces/${ws}/environments/provision`, { blockId: 'b' })

      const call = stub.calls.find((c) => c.url === 'https://envs.test/api/environments')
      expect(call).toBeDefined()
      assert(call!)
    },
  )
})
