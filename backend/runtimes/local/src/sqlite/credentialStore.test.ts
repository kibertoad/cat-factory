import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  PersonalSubscriptionRecord,
  ProviderApiKeyRecord,
  ProviderSubscriptionTokenRecord,
  SubscriptionActivationRecord,
} from '@cat-factory/kernel'
import { type LocalCredentialStore, createLocalCredentialStore } from './credentialStore.js'

// Unit coverage for the mothership-mode local credential store. It asserts the
// `local-sqlite` repositories behave identically to their Drizzle/D1 counterparts —
// the API-key pool's usage-window rotation, lease-least-used ordering, soft-delete
// tombstones, and createdAt-preserving endpoint upsert; and the subscription-credential
// trio's per-workspace pooling, one-live-row-per-user personal upsert, and per-run
// activation TTL semantics — against an in-memory `node:sqlite` db.

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
    enabled: true,
    isDefault: false,
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

    // `cold` now carries a lastUsedAt but still no window usage, `hot` carries 200 in-window
    // tokens, so `cold` keeps winning on lower rolling-window usage (0 < 200).
    const second = await repo.leaseLeastUsed(scopes, 'openai', 21_000, WINDOW)
    expect(second?.id).toBe('cold')
  })

  it('orders by rolling-window usage (full input+output token sum) when both keys are live', async () => {
    const repo = store.providerApiKeyRepository
    const scopes = [{ scope: 'workspace' as const, scopeId: 'ws_1' }]
    // Both keys are leased and in an ACTIVE window, so the never-leased / NULLS-FIRST shortcut
    // never fires — the winner is decided purely by `input_tokens + output_tokens` ASC.
    // `light` has the larger input count but the smaller TOTAL, so this also pins the sum to
    // both columns (an input-only sum, or a DESC order, would pick `heavy` and fail).
    await repo.add(
      apiKey({
        id: 'light',
        createdAt: 1,
        windowStartedAt: 90_000,
        inputTokens: 100,
        outputTokens: 10, // total 110
        lastUsedAt: 90_000,
      }),
    )
    await repo.add(
      apiKey({
        id: 'heavy',
        createdAt: 2,
        windowStartedAt: 90_000,
        inputTokens: 20,
        outputTokens: 200, // total 220
        lastUsedAt: 90_000,
      }),
    )
    const leased = await repo.leaseLeastUsed(scopes, 'openai', 100_000, WINDOW)
    expect(leased?.id).toBe('light')
  })

  it('ignores usage from an expired window when leasing', async () => {
    const repo = store.providerApiKeyRepository
    const scopes = [{ scope: 'workspace' as const, scopeId: 'ws_1' }]
    // `stale` carries huge counters but its window (started 1000) is long expired at now=100000,
    // so it counts as 0 usage. `busy` is in an ACTIVE window with a small but non-zero usage.
    // The expiry branch is the ONLY thing that lets `stale` (0) beat `busy` (20): drop or invert
    // the `now - window_started_at >= windowMs THEN 0` reset and `stale` reads 19998 and loses.
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
    await repo.add(
      apiKey({
        id: 'busy',
        createdAt: 2,
        windowStartedAt: 80_000,
        inputTokens: 10,
        outputTokens: 10, // total 20, in-window
        lastUsedAt: 80_000,
      }),
    )
    const leased = await repo.leaseLeastUsed(scopes, 'openai', 100_000, WINDOW)
    expect(leased?.id).toBe('stale')
  })

  it('never leases a soft-deleted or wrong-provider key', async () => {
    const repo = store.providerApiKeyRepository
    const scopes = [{ scope: 'workspace' as const, scopeId: 'ws_1' }]
    // `del` and `wrong` are both never-leased (0 usage, NULL last_used_at) so each would WIN the
    // lease ordering if its guard were dropped; `ok` carries usage so it only wins once both are
    // excluded by the `deleted_at IS NULL` + `provider = ?` filters.
    await repo.add(apiKey({ id: 'del', provider: 'openai', createdAt: 1 }))
    await repo.softDelete('workspace', 'ws_1', 'del', 9999)
    await repo.add(apiKey({ id: 'wrong', provider: 'anthropic', createdAt: 2 }))
    await repo.add(
      apiKey({
        id: 'ok',
        provider: 'openai',
        createdAt: 3,
        windowStartedAt: 95_000,
        lastUsedAt: 95_000,
      }),
    )

    const leased = await repo.leaseLeastUsed(scopes, 'openai', 100_000, WINDOW)
    expect(leased?.id).toBe('ok')
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

function subToken(
  overrides: Partial<ProviderSubscriptionTokenRecord> = {},
): ProviderSubscriptionTokenRecord {
  return {
    id: 'sub_1',
    workspaceId: 'ws_1',
    vendor: 'claude',
    label: 'Claude Max',
    tokenCipher: 'sealed:token',
    createdAt: 1000,
    lastUsedAt: null,
    windowStartedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    enabled: true,
    isDefault: false,
    deletedAt: null,
    ...overrides,
  }
}

describe('SqliteProviderSubscriptionTokenRepository', () => {
  let store: LocalCredentialStore

  beforeEach(() => {
    store = createLocalCredentialStore(':memory:')
  })
  afterEach(() => store.close())

  it('adds and lists by vendor, oldest first, excluding other vendors + tombstones', async () => {
    const repo = store.providerSubscriptionTokenRepository
    await repo.add(subToken({ id: 'a', createdAt: 2000, vendor: 'claude' }))
    await repo.add(subToken({ id: 'b', createdAt: 1000, vendor: 'claude' }))
    await repo.add(subToken({ id: 'c', createdAt: 1500, vendor: 'codex' }))
    await repo.add(subToken({ id: 'd', createdAt: 1200, vendor: 'claude' }))
    await repo.softDelete('ws_1', 'd', 9999)

    const claude = await repo.listByVendor('ws_1', 'claude')
    expect(claude.map((r) => r.id)).toEqual(['b', 'a'])
    expect((await repo.listByVendor('ws_1', 'codex')).map((r) => r.id)).toEqual(['c'])
    // A different workspace shares no pool.
    expect(await repo.listByVendor('ws_other', 'claude')).toEqual([])
  })

  it('scopes getById to the workspace and hides tombstoned tokens', async () => {
    const repo = store.providerSubscriptionTokenRepository
    await repo.add(subToken({ id: 'a' }))
    expect(await repo.getById('ws_1', 'a')).not.toBeNull()
    expect(await repo.getById('ws_other', 'a')).toBeNull()
    await repo.softDelete('ws_1', 'a', 5000)
    expect(await repo.getById('ws_1', 'a')).toBeNull()
  })

  it('round-trips the full record (sealed cipher + counters)', async () => {
    const repo = store.providerSubscriptionTokenRepository
    const record = subToken({
      id: 'a',
      lastUsedAt: 42,
      windowStartedAt: 10,
      inputTokens: 3,
      outputTokens: 4,
      requestCount: 2,
    })
    await repo.add(record)
    expect(await repo.getById('ws_1', 'a')).toEqual(record)
  })

  it('marks a token leased scoped to the workspace', async () => {
    const repo = store.providerSubscriptionTokenRepository
    await repo.add(subToken({ id: 'a', lastUsedAt: null }))
    await repo.markLeased('ws_other', 'a', 111) // wrong workspace → no-op
    expect((await repo.getById('ws_1', 'a'))?.lastUsedAt).toBeNull()
    await repo.markLeased('ws_1', 'a', 4242)
    expect((await repo.getById('ws_1', 'a'))?.lastUsedAt).toBe(4242)
  })

  it('accumulates usage within a window and resets after it expires', async () => {
    const repo = store.providerSubscriptionTokenRepository
    await repo.add(subToken({ id: 'a' }))
    await repo.recordUsage('ws_1', 'a', { inputTokens: 10, outputTokens: 5 }, 1000, WINDOW)
    expect(await repo.getById('ws_1', 'a')).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
      windowStartedAt: 1000,
    })
    // Same window → accumulate.
    await repo.recordUsage('ws_1', 'a', { inputTokens: 3, outputTokens: 2 }, 1500, WINDOW)
    expect(await repo.getById('ws_1', 'a')).toMatchObject({
      inputTokens: 13,
      outputTokens: 7,
      requestCount: 2,
    })
    // Past the window → reset, starting from this call.
    await repo.recordUsage('ws_1', 'a', { inputTokens: 1, outputTokens: 1 }, 100_000, WINDOW)
    expect(await repo.getById('ws_1', 'a')).toMatchObject({
      inputTokens: 1,
      outputTokens: 1,
      requestCount: 1,
      windowStartedAt: 100_000,
    })
  })
})

function personalSub(
  overrides: Partial<PersonalSubscriptionRecord> = {},
): PersonalSubscriptionRecord {
  return {
    id: 'per_1',
    userId: 'usr_1',
    vendor: 'claude',
    label: 'My Claude',
    tokenCipher: 'sealed:double',
    expiresAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

describe('SqlitePersonalSubscriptionRepository', () => {
  let store: LocalCredentialStore

  beforeEach(() => {
    store = createLocalCredentialStore(':memory:')
  })
  afterEach(() => store.close())

  it('upserts and reads one live credential per user+vendor', async () => {
    const repo = store.personalSubscriptionRepository
    await repo.upsert(personalSub({ id: 'per_1', label: 'First' }))
    const got = await repo.getByUserVendor('usr_1', 'claude')
    expect(got).toMatchObject({ id: 'per_1', label: 'First', tokenCipher: 'sealed:double' })
    expect(await repo.getByUserVendor('usr_1', 'codex')).toBeNull()
    expect(await repo.getByUserVendor('usr_other', 'claude')).toBeNull()
  })

  it('tombstones a prior live row when a NEW id is upserted for the same user+vendor', async () => {
    const repo = store.personalSubscriptionRepository
    await repo.upsert(personalSub({ id: 'old', createdAt: 1000, updatedAt: 1000 }))
    await repo.upsert(personalSub({ id: 'new', createdAt: 2000, updatedAt: 2000 }))
    // Exactly one live row, the newer id.
    expect((await repo.getByUserVendor('usr_1', 'claude'))?.id).toBe('new')
    expect((await repo.listByUser('usr_1')).map((r) => r.id)).toEqual(['new'])
  })

  it('updates in place when the SAME id is re-upserted (conflict path)', async () => {
    const repo = store.personalSubscriptionRepository
    await repo.upsert(
      personalSub({ id: 'per_1', label: 'First', createdAt: 1000, updatedAt: 1000 }),
    )
    await repo.upsert(
      personalSub({ id: 'per_1', label: 'Renewed', tokenCipher: 'sealed:new', updatedAt: 2000 }),
    )
    expect(await repo.getByUserVendor('usr_1', 'claude')).toMatchObject({
      id: 'per_1',
      label: 'Renewed',
      tokenCipher: 'sealed:new',
      updatedAt: 2000,
    })
    expect(await repo.listByUser('usr_1')).toHaveLength(1)
  })

  it('marks used and soft-deletes', async () => {
    const repo = store.personalSubscriptionRepository
    await repo.upsert(personalSub({ id: 'per_1' }))
    await repo.markUsed('usr_1', 'claude', 555)
    expect((await repo.getByUserVendor('usr_1', 'claude'))?.lastUsedAt).toBe(555)
    await repo.softDelete('usr_1', 'claude', 9999)
    expect(await repo.getByUserVendor('usr_1', 'claude')).toBeNull()
    expect(await repo.listByUser('usr_1')).toEqual([])
  })

  it('lists expiring credentials in the horizon, excluding null-expiry + deleted', async () => {
    const repo = store.personalSubscriptionRepository
    await repo.upsert(personalSub({ id: 'soon', vendor: 'claude', expiresAt: 5000 }))
    await repo.upsert(personalSub({ id: 'later', vendor: 'codex', expiresAt: 50_000 }))
    await repo.upsert(personalSub({ id: 'never', vendor: 'glm', expiresAt: null }))
    await repo.upsert(personalSub({ id: 'gone', vendor: 'kimi', expiresAt: 6000 }))
    await repo.softDelete('usr_1', 'kimi', 9999)

    const expiring = await repo.listExpiring(1000, 10_000)
    expect(expiring.map((r) => r.id)).toEqual(['soon']) // later > horizon, never has no expiry, gone deleted
  })
})

function activation(
  overrides: Partial<SubscriptionActivationRecord> = {},
): SubscriptionActivationRecord {
  return {
    id: 'act_1',
    executionId: 'ex_1',
    userId: 'usr_1',
    vendor: 'claude',
    tokenCipher: 'sealed:system-only',
    createdAt: 1000,
    expiresAt: 100_000,
    ...overrides,
  }
}

describe('SqliteSubscriptionActivationRepository', () => {
  let store: LocalCredentialStore

  beforeEach(() => {
    store = createLocalCredentialStore(':memory:')
  })
  afterEach(() => store.close())

  it('gets an unexpired activation and hides an expired one', async () => {
    const repo = store.subscriptionActivationRepository
    await repo.upsert(activation({ expiresAt: 5000 }))
    expect(await repo.get('ex_1', 'usr_1', 'claude', 4000)).toMatchObject({ id: 'act_1' })
    // At/after expiry → treated as absent (get uses strictly-greater).
    expect(await repo.get('ex_1', 'usr_1', 'claude', 5000)).toBeNull()
    expect(await repo.get('ex_1', 'usr_1', 'claude', 6000)).toBeNull()
    // Wrong run/user/vendor → absent.
    expect(await repo.get('ex_other', 'usr_1', 'claude', 4000)).toBeNull()
  })

  it('replaces on conflict of (execution, user, vendor)', async () => {
    const repo = store.subscriptionActivationRepository
    await repo.upsert(activation({ id: 'a', tokenCipher: 'sealed:1', expiresAt: 5000 }))
    // Same (execution, user, vendor), different id/cipher/ttl → row is replaced in place.
    await repo.upsert(activation({ id: 'b', tokenCipher: 'sealed:2', expiresAt: 9000 }))
    const got = await repo.get('ex_1', 'usr_1', 'claude', 1)
    expect(got).toMatchObject({ tokenCipher: 'sealed:2', expiresAt: 9000 })
  })

  it('deletes all activations for a finished execution', async () => {
    const repo = store.subscriptionActivationRepository
    await repo.upsert(activation({ id: 'a', executionId: 'ex_1', vendor: 'claude' }))
    await repo.upsert(activation({ id: 'b', executionId: 'ex_1', vendor: 'codex' }))
    await repo.upsert(activation({ id: 'c', executionId: 'ex_2', vendor: 'claude' }))
    await repo.deleteByExecution('ex_1')
    expect(await repo.get('ex_1', 'usr_1', 'claude', 1)).toBeNull()
    expect(await repo.get('ex_1', 'usr_1', 'codex', 1)).toBeNull()
    expect(await repo.get('ex_2', 'usr_1', 'claude', 1)).not.toBeNull()
  })

  it('deletes expired activations and returns the count', async () => {
    const repo = store.subscriptionActivationRepository
    await repo.upsert(activation({ id: 'a', executionId: 'ex_1', expiresAt: 1000 }))
    await repo.upsert(activation({ id: 'b', executionId: 'ex_2', expiresAt: 2000 }))
    await repo.upsert(activation({ id: 'c', executionId: 'ex_3', expiresAt: 9000 }))
    // expires_at <= now → deleted (a and b), c survives.
    expect(await repo.deleteExpired(2000)).toBe(2)
    expect(await repo.get('ex_3', 'usr_1', 'claude', 1)).not.toBeNull()
    expect(await repo.deleteExpired(2000)).toBe(0)
  })
})
