import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderApiKeyRecord } from '@cat-factory/kernel'
import { type LocalCredentialStore, createLocalCredentialStore } from './credentialStore.js'

// Unit coverage for the mothership-mode local credential store. It asserts the two
// `local-sqlite` repositories behave identically to their Drizzle/D1 counterparts —
// pool reads, usage-window rotation, lease-least-used ordering, soft-delete tombstones,
// and the createdAt-preserving endpoint upsert — against an in-memory `node:sqlite` db.

const WINDOW = 60_000

function apiKey(overrides: Partial<ProviderApiKeyRecord> = {}): ProviderApiKeyRecord {
  return {
    id: 'apikey_1',
    scope: 'workspace',
    scopeId: 'ws_1',
    provider: 'openai',
    label: 'key',
    keyCipher: 'sealed:key',
    createdAt: 1000,
    lastUsedAt: null,
    windowStartedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    deletedAt: null,
    ...overrides,
  }
}

describe('SqliteProviderApiKeyRepository', () => {
  let store: LocalCredentialStore

  beforeEach(() => {
    store = createLocalCredentialStore(':memory:')
  })
  afterEach(() => store.close())

  it('adds and lists by scope, oldest first, filtered by provider', async () => {
    const repo = store.providerApiKeyRepository
    await repo.add(apiKey({ id: 'a', createdAt: 2000, provider: 'openai' }))
    await repo.add(apiKey({ id: 'b', createdAt: 1000, provider: 'openai' }))
    await repo.add(apiKey({ id: 'c', createdAt: 1500, provider: 'anthropic' }))

    const all = await repo.listByScope('workspace', 'ws_1')
    expect(all.map((r) => r.id)).toEqual(['b', 'c', 'a'])

    const openai = await repo.listByScope('workspace', 'ws_1', 'openai')
    expect(openai.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('merges a pool across scope segments and excludes deleted keys', async () => {
    const repo = store.providerApiKeyRepository
    await repo.add(apiKey({ id: 'ws', scope: 'workspace', scopeId: 'ws_1', createdAt: 1 }))
    await repo.add(apiKey({ id: 'acc', scope: 'account', scopeId: 'acc_1', createdAt: 2 }))
    await repo.add(apiKey({ id: 'usr', scope: 'user', scopeId: 'usr_1', createdAt: 3 }))
    await repo.add(apiKey({ id: 'other', scope: 'workspace', scopeId: 'ws_other', createdAt: 4 }))
    await repo.softDelete('account', 'acc_1', 'acc', 9999)

    const scopes = [
      { scope: 'workspace' as const, scopeId: 'ws_1' },
      { scope: 'account' as const, scopeId: 'acc_1' },
      { scope: 'user' as const, scopeId: 'usr_1' },
    ]
    const pool = await repo.listForPool(scopes, 'openai')
    expect(pool.map((r) => r.id)).toEqual(['ws', 'usr'])
    expect(await repo.listConfiguredProviders(scopes)).toEqual(['openai'])
  })

  it('scopes getById and hides tombstoned keys', async () => {
    const repo = store.providerApiKeyRepository
    await repo.add(apiKey({ id: 'a' }))
    expect(await repo.getById('workspace', 'ws_1', 'a')).not.toBeNull()
    // wrong scope → not found
    expect(await repo.getById('account', 'ws_1', 'a')).toBeNull()
    await repo.softDelete('workspace', 'ws_1', 'a', 5000)
    expect(await repo.getById('workspace', 'ws_1', 'a')).toBeNull()
  })

  it('leases never-used keys first, then least rolling-window usage', async () => {
    const repo = store.providerApiKeyRepository
    const scopes = [{ scope: 'workspace' as const, scopeId: 'ws_1' }]
    // `hot` has recent usage, `cold` is fresh but older, `used` was leased long ago.
    await repo.add(
      apiKey({
        id: 'hot',
        createdAt: 1,
        windowStartedAt: 10_000,
        inputTokens: 100,
        outputTokens: 100,
        lastUsedAt: 10_000,
      }),
    )
    await repo.add(apiKey({ id: 'cold', createdAt: 2, lastUsedAt: null }))

    // Never-leased wins regardless of created order.
    const first = await repo.leaseLeastUsed(scopes, 'openai', 20_000, WINDOW)
    expect(first?.id).toBe('cold')
    expect(first?.lastUsedAt).toBe(20_000)

    // Now both have usage; `hot` still carries its window tokens, `cold` none → cold again.
    const second = await repo.leaseLeastUsed(scopes, 'openai', 21_000, WINDOW)
    expect(second?.id).toBe('cold')
  })

  it('ignores usage from an expired window when leasing', async () => {
    const repo = store.providerApiKeyRepository
    const scopes = [{ scope: 'workspace' as const, scopeId: 'ws_1' }]
    await repo.add(
      apiKey({
        id: 'stale',
        createdAt: 1,
        windowStartedAt: 1000,
        inputTokens: 9999,
        outputTokens: 9999,
        lastUsedAt: 1000,
      }),
    )
    await repo.add(apiKey({ id: 'fresh', createdAt: 2, lastUsedAt: 500 }))
    // At now=100000 the stale window (started 1000) is long expired → counts as 0 usage, so
    // it ties `fresh` on usage and wins on least-recently-leased (1000 vs ... fresh=500).
    // fresh was leased earlier (500 < 1000) so fresh wins the tiebreak.
    const leased = await repo.leaseLeastUsed(scopes, 'openai', 100_000, WINDOW)
    expect(leased?.id).toBe('fresh')
  })

  it('returns null when the pool is empty', async () => {
    const repo = store.providerApiKeyRepository
    expect(await repo.leaseLeastUsed([], 'openai', 1, WINDOW)).toBeNull()
    expect(
      await repo.leaseLeastUsed([{ scope: 'workspace', scopeId: 'ws_1' }], 'openai', 1, WINDOW),
    ).toBeNull()
  })

  it('accumulates usage within a window and resets after it expires', async () => {
    const repo = store.providerApiKeyRepository
    await repo.add(apiKey({ id: 'a' }))
    await repo.recordUsage('a', { inputTokens: 10, outputTokens: 5 }, 1000, WINDOW)
    let row = await repo.getById('workspace', 'ws_1', 'a')
    expect(row).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
      windowStartedAt: 1000,
    })

    // Same window → accumulate.
    await repo.recordUsage('a', { inputTokens: 3, outputTokens: 2 }, 1500, WINDOW)
    row = await repo.getById('workspace', 'ws_1', 'a')
    expect(row).toMatchObject({ inputTokens: 13, outputTokens: 7, requestCount: 2 })

    // Past the window → reset, starting from this call.
    await repo.recordUsage('a', { inputTokens: 1, outputTokens: 1 }, 100_000, WINDOW)
    row = await repo.getById('workspace', 'ws_1', 'a')
    expect(row).toMatchObject({
      inputTokens: 1,
      outputTokens: 1,
      requestCount: 1,
      windowStartedAt: 100_000,
    })
  })

  it('marks a key leased by id alone', async () => {
    const repo = store.providerApiKeyRepository
    await repo.add(apiKey({ id: 'a', lastUsedAt: null }))
    await repo.markLeased('a', 4242)
    expect((await repo.getById('workspace', 'ws_1', 'a'))?.lastUsedAt).toBe(4242)
  })
})

describe('SqliteLocalModelEndpointRepository', () => {
  let store: LocalCredentialStore

  beforeEach(() => {
    store = createLocalCredentialStore(':memory:')
  })
  afterEach(() => store.close())

  it('upserts, reads, and lists endpoints with a null cipher round-trip', async () => {
    const repo = store.localModelEndpointRepository
    await repo.upsert({
      userId: 'usr_1',
      provider: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyCipher: null,
      models: ['llama3', 'qwen'],
      createdAt: 100,
      updatedAt: 100,
    })
    const got = await repo.getByUserProvider('usr_1', 'ollama')
    expect(got).toEqual({
      userId: 'usr_1',
      provider: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyCipher: null,
      models: ['llama3', 'qwen'],
      createdAt: 100,
      updatedAt: 100,
    })
    expect(await repo.getByUserProvider('usr_1', 'lmstudio')).toBeNull()
  })

  it('preserves createdAt and overwrites mutable fields on upsert conflict', async () => {
    const repo = store.localModelEndpointRepository
    await repo.upsert({
      userId: 'usr_1',
      provider: 'ollama',
      label: 'First',
      baseUrl: 'http://a/v1',
      apiKeyCipher: null,
      models: ['a'],
      createdAt: 100,
      updatedAt: 100,
    })
    await repo.upsert({
      userId: 'usr_1',
      provider: 'ollama',
      label: 'Second',
      baseUrl: 'http://b/v1',
      apiKeyCipher: 'sealed:key',
      models: ['b', 'c'],
      createdAt: 999, // must be ignored
      updatedAt: 200,
    })
    const got = await repo.getByUserProvider('usr_1', 'ollama')
    expect(got).toMatchObject({
      label: 'Second',
      baseUrl: 'http://b/v1',
      apiKeyCipher: 'sealed:key',
      models: ['b', 'c'],
      createdAt: 100,
      updatedAt: 200,
    })
  })

  it('lists a user endpoints oldest first and removes by provider', async () => {
    const repo = store.localModelEndpointRepository
    await repo.upsert(endpoint('ollama', 20))
    await repo.upsert(endpoint('lmstudio', 10))
    expect((await repo.listByUser('usr_1')).map((r) => r.provider)).toEqual(['lmstudio', 'ollama'])
    await repo.remove('usr_1', 'ollama')
    expect((await repo.listByUser('usr_1')).map((r) => r.provider)).toEqual(['lmstudio'])
  })
})

function endpoint(provider: 'ollama' | 'lmstudio', createdAt: number) {
  return {
    userId: 'usr_1',
    provider,
    label: provider,
    baseUrl: `http://localhost/${provider}/v1`,
    apiKeyCipher: null,
    models: [],
    createdAt,
    updatedAt: createdAt,
  }
}
