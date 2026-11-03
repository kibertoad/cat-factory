import { describe, it, expect, vi } from 'vitest'
import { useApiKeysStore } from '~/stores/apiKeys'
import type { ApiKey, ApiKeyProvider } from '~/types/domain'

/**
 * "Configured" is the server's answer, never one derived from the key rows, which leave out the
 * account's keys. The rows only decide whether a provider that is NOT configured has a key the
 * caller could turn back on.
 */
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

function stubApi(seed: { workspaceKeys?: ApiKey[] | 'failing'; configured: ApiKeyProvider[][] }) {
  const configured = [...seed.configured]
  const api = {
    listWorkspaceApiKeys: () =>
      seed.workspaceKeys === 'failing'
        ? Promise.reject(new Error('key list failed'))
        : Promise.resolve({ keys: seed.workspaceKeys ?? [] }),
    listMyApiKeys: () => Promise.resolve({ keys: [] }),
    listConfiguredProviders: vi.fn(() =>
      Promise.resolve({ providers: configured.length > 1 ? configured.shift()! : configured[0]! }),
    ),
    updateWorkspaceApiKey: (_ws: string, id: string, patch: Partial<ApiKey>) =>
      Promise.resolve(key({ id, ...patch })),
  }
  vi.stubGlobal('useApi', () => api)
  return api
}

describe('apiKeys store', () => {
  it('reads a provider whose only key is disabled as disabled, not connected', async () => {
    stubApi({ workspaceKeys: [key({ enabled: false })], configured: [[]] })
    const store = useApiKeysStore()
    await store.load('ws1')

    expect(store.configuredProviders.has('openrouter')).toBe(false)
    expect(store.keyState('openrouter')).toBe('disabled')
  })

  it('takes a provider the server configures as connected, even with no key row in sight', async () => {
    // An account-scoped key: the server counts it, and no list here carries it.
    stubApi({ workspaceKeys: [], configured: [['openrouter']] })
    const store = useApiKeysStore()
    await store.load('ws1')

    expect(store.keyState('openrouter')).toBe('connected')
    expect(store.keyState('anthropic')).toBe('none')
  })

  it('keeps the configured providers when the workspace key list fails to load', async () => {
    stubApi({ workspaceKeys: 'failing', configured: [['openrouter']] })
    const store = useApiKeysStore()
    await expect(store.load('ws1')).rejects.toThrow('key list failed')

    expect(store.configuredProviders.has('openrouter')).toBe(true)
  })

  it('re-reads the configured providers after a key is turned back on', async () => {
    const api = stubApi({
      workspaceKeys: [key({ enabled: false })],
      configured: [[], ['openrouter']],
    })
    const store = useApiKeysStore()
    await store.load('ws1')
    expect(store.keyState('openrouter')).toBe('disabled')

    await store.updateWorkspaceKey('k1', { enabled: true })

    expect(api.listConfiguredProviders).toHaveBeenCalledTimes(2)
    expect(store.keyState('openrouter')).toBe('connected')
  })
})
