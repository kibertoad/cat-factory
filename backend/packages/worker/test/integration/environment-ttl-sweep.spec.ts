import type { EnvironmentHandle } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { makeApp } from '../helpers'
import { SystemClock } from '../../src/infrastructure/runtime'
import { sweepExpiredEnvironments } from '../../src/infrastructure/environments/sweep'
import {
  bearerManifest,
  readyEnvBody,
  recordingFetch,
  TEST_API_TOKEN,
} from './environment.fixtures'

afterEach(() => vi.unstubAllGlobals())

describe('environment TTL sweep', () => {
  it('tears down expired environments and tombstones them', async () => {
    // Provision an already-expired environment.
    const stub = recordingFetch(() => ({ body: readyEnvBody(Date.now() - 1000) }))
    vi.stubGlobal('fetch', stub.fn)

    const app = makeApp()
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/environments/connection`, {
      manifest: bearerManifest(),
      secrets: { API_TOKEN: TEST_API_TOKEN },
    })
    await app.call('POST', `/workspaces/${ws}/environments/provision`, { blockId: 'b' })

    const swept = await sweepExpiredEnvironments(env, new SystemClock())
    expect(swept).toBe(1)

    // The provider's teardown endpoint was called for the external id.
    expect(
      stub.calls.some(
        (c) => c.method === 'DELETE' && c.url === 'https://envs.test/api/environments/env-1',
      ),
    ).toBe(true)

    // The registry no longer lists it.
    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${ws}/environments`)
    expect(envs.body).toHaveLength(0)
  })
})
