import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePublicApiKeysStore } from '~/stores/publicApiKeys'
import { useWorkspaceStore } from '~/stores/workspace'
import type { CreatedPublicApiKey, PublicApiKey } from '~/types/publicApiKeys'

/** Minimal metadata-view factory — only the fields the store passes through. */
function key(over: Partial<PublicApiKey> = {}): PublicApiKey {
  return {
    id: 'pak_1',
    accountId: 'acc1',
    workspaceId: 'ws1',
    label: 'CI',
    scope: 'write',
    createdByUserId: null,
    createdAt: 1,
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  }
}

describe('publicApiKeys store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('load stores the key list and marks the feature available', async () => {
    vi.stubGlobal('useApi', () => ({
      listPublicApiKeys: () => Promise.resolve({ keys: [key()] }),
    }))

    const store = usePublicApiKeysStore()
    await store.load()

    expect(store.available).toBe(true)
    expect(store.keys).toHaveLength(1)
    expect(store.loading).toBe(false)
  })

  it('a definitive 503 latches the feature unavailable and clears the list', async () => {
    vi.stubGlobal('useApi', () => ({
      listPublicApiKeys: () => Promise.reject({ statusCode: 503 }),
    }))

    const store = usePublicApiKeysStore()
    await store.load()

    expect(store.available).toBe(false)
    expect(store.keys).toEqual([])
  })

  it('a transient failure leaves `available` null so ensureLoaded stays retryable', async () => {
    vi.stubGlobal('useApi', () => ({
      listPublicApiKeys: () => Promise.reject({ statusCode: 500 }),
    }))

    const store = usePublicApiKeysStore()
    await store.load()

    // Never latched — a network/5xx blip must not hide an otherwise-available panel.
    expect(store.available).toBeNull()
  })

  it('ensureLoaded coalesces concurrent callers into one request', async () => {
    const list = vi.fn(() => Promise.resolve({ keys: [key()] }))
    vi.stubGlobal('useApi', () => ({ listPublicApiKeys: list }))

    const store = usePublicApiKeysStore()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    // And once probed, it never re-fetches.
    await store.ensureLoaded()

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('create prepends the new key (newest-first) and returns the one-time secret', async () => {
    const created: CreatedPublicApiKey = {
      key: key({ id: 'pak_new', label: 'deploy' }),
      secret: 'cf_live_pak_new.abc',
    }
    vi.stubGlobal('useApi', () => ({
      listPublicApiKeys: () => Promise.resolve({ keys: [key({ id: 'pak_old' })] }),
      createPublicApiKey: () => Promise.resolve(created),
    }))

    const store = usePublicApiKeysStore()
    await store.load()
    const result = await store.create('deploy', 'admin')

    expect(result.secret).toBe('cf_live_pak_new.abc')
    expect(store.keys.map((k) => k.id)).toEqual(['pak_new', 'pak_old'])
    expect(store.available).toBe(true)
  })

  it('revoke drops the key from the list', async () => {
    vi.stubGlobal('useApi', () => ({
      listPublicApiKeys: () => Promise.resolve({ keys: [key({ id: 'a' }), key({ id: 'b' })] }),
      revokePublicApiKey: () => Promise.resolve(),
    }))

    const store = usePublicApiKeysStore()
    await store.load()
    await store.revoke('a')

    expect(store.keys.map((k) => k.id)).toEqual(['b'])
  })
})
