import { describe, it, expect, vi } from 'vitest'
import { useApiKeysStore } from '~/stores/apiKeys'
import type { ApiKey } from '~/types/domain'

function key(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k1',
    scope: 'workspace',
    scopeId: 'ws1',
    provider: 'openrouter',
    label: 'Main',
    createdAt: 1000,
    lastUsedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    enabled: true,
    isDefault: false,
    ...over,
  }
}

async function loadStore(workspaceKeys: ApiKey[], userKeys: ApiKey[] = []) {
  vi.stubGlobal('useApi', () => ({
    listWorkspaceApiKeys: () => Promise.resolve({ keys: workspaceKeys }),
    listMyApiKeys: () => Promise.resolve({ keys: userKeys }),
  }))
  const store = useApiKeysStore()
  await store.load('ws1')
  return store
}

describe('apiKeys store', () => {
  it('does not count a provider whose only key is disabled as configured', async () => {
    const store = await loadStore([key({ enabled: false })])

    expect(store.configuredProviders.has('openrouter')).toBe(false)
    expect(store.hasProvider('openrouter')).toBe(false)
  })

  it('counts a provider as configured when any reachable key for it is enabled', async () => {
    const store = await loadStore(
      [key({ id: 'k1', enabled: false })],
      [key({ id: 'k2', scope: 'user', scopeId: 'u1' })],
    )

    expect(store.hasProvider('openrouter')).toBe(true)
  })
})
