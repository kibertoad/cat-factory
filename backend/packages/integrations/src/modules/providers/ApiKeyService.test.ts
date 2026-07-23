import { describe, expect, it } from 'vitest'
import { ConflictError } from '@cat-factory/kernel'
import type {
  ApiKeyProvider,
  ApiKeyScope,
  ApiKeyScopeRef,
  Clock,
  IdGenerator,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
  SecretCipher,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ApiKeyService } from './ApiKeyService.js'
import { chooseToken } from './providers.logic.js'

// Service-level behaviour of the direct-provider API-key pool over an in-memory repo:
// encryption-at-rest (the raw key never lands in the row), the THREE-SCOPE merge
// (workspace + owning account + the run initiator's user keys), usage-aware leasing +
// the window-reset usage round-trip, and the configured-providers/has-key reads the
// catalog + pipeline-start guard depend on. The pure rotation choice is covered in
// providers.logic.test; this exercises the scope-merge wiring.

const WINDOW = 5 * 60 * 60 * 1000
const WS = 'ws_1'
const ACC = 'acc_1'
const USER = 'usr_1'

const fakeCipher: SecretCipher = {
  encrypt: async (plaintext) => `enc(${plaintext})`,
  decrypt: async (envelope) => envelope.replace(/^enc\(([\s\S]*)\)$/, '$1'),
}

// The workspace's owning account is `ACC`, so lease()/hasKey() merge it into the pool.
const workspaceRepository: WorkspaceRepository = {
  get: async (id: string) => ({ id, name: id }) as Workspace,
  accountOf: async () => ACC,
} as unknown as WorkspaceRepository

class FakeRepo implements ProviderApiKeyRepository {
  rows: ProviderApiKeyRecord[] = []
  private matches(r: ProviderApiKeyRecord, scopes: ApiKeyScopeRef[]): boolean {
    return scopes.some((s) => s.scope === r.scope && s.scopeId === r.scopeId)
  }
  async listByScope(scope: ApiKeyScope, scopeId: string, provider?: ApiKeyProvider) {
    return this.rows
      .filter(
        (r) =>
          r.scope === scope &&
          r.scopeId === scopeId &&
          (provider === undefined || r.provider === provider) &&
          r.deletedAt === null,
      )
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  async listForPool(scopes: ApiKeyScopeRef[], provider: ApiKeyProvider) {
    return this.rows
      .filter(
        (r) =>
          r.deletedAt === null && r.enabled && r.provider === provider && this.matches(r, scopes),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  async listConfiguredProviders(scopes: ApiKeyScopeRef[]) {
    const set = new Set<ApiKeyProvider>()
    for (const r of this.rows) {
      if (r.deletedAt === null && r.enabled && this.matches(r, scopes)) set.add(r.provider)
    }
    return [...set]
  }
  async getById(scope: ApiKeyScope, scopeId: string, id: string) {
    return (
      this.rows.find(
        (r) => r.id === id && r.scope === scope && r.scopeId === scopeId && !r.deletedAt,
      ) ?? null
    )
  }
  async add(record: ProviderApiKeyRecord) {
    this.rows.push({ ...record })
  }
  async markLeased(id: string, at: number) {
    const row = this.rows.find((r) => r.id === id)
    if (row) row.lastUsedAt = at
  }
  async leaseLeastUsed(
    scopes: ApiKeyScopeRef[],
    provider: ApiKeyProvider,
    now: number,
    windowMs: number,
  ) {
    const pool = this.rows.filter(
      (r) => r.deletedAt === null && r.provider === provider && this.matches(r, scopes),
    )
    const chosen = chooseToken(pool, now, windowMs)
    if (!chosen) return null
    chosen.lastUsedAt = now
    return { ...chosen }
  }
  async recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ) {
    const row = this.rows.find((r) => r.id === id)
    if (!row) return
    const active = row.windowStartedAt !== null && at - row.windowStartedAt < windowMs
    row.windowStartedAt = active ? row.windowStartedAt : at
    row.inputTokens = (active ? row.inputTokens : 0) + usage.inputTokens
    row.outputTokens = (active ? row.outputTokens : 0) + usage.outputTokens
    row.requestCount = (active ? row.requestCount : 0) + 1
  }
  async setEnabled(scope: ApiKeyScope, scopeId: string, id: string, enabled: boolean) {
    const row = this.rows.find(
      (r) => r.id === id && r.scope === scope && r.scopeId === scopeId && !r.deletedAt,
    )
    if (row) row.enabled = enabled
  }
  async setDefault(
    scope: ApiKeyScope,
    scopeId: string,
    provider: ApiKeyProvider,
    id: string | null,
  ) {
    for (const r of this.rows) {
      if (r.scope === scope && r.scopeId === scopeId && r.provider === provider && !r.deletedAt) {
        r.isDefault = id !== null && r.id === id
      }
    }
  }
  async softDelete(scope: ApiKeyScope, scopeId: string, id: string, at: number) {
    const row = this.rows.find(
      (r) => r.id === id && r.scope === scope && r.scopeId === scopeId && !r.deletedAt,
    )
    if (row) row.deletedAt = at
  }
}

function build(now = () => 1000) {
  const repo = new FakeRepo()
  let seq = 0
  const idGenerator: IdGenerator = { next: (prefix: string) => `${prefix}_${++seq}` }
  const clock: Clock = { now }
  const service = new ApiKeyService({
    providerApiKeyRepository: repo,
    workspaceRepository,
    secretCipher: fakeCipher,
    idGenerator,
    clock,
    usageWindowMs: WINDOW,
  })
  return { repo, service }
}

describe('ApiKeyService', () => {
  it('encrypts at rest and returns secret-free summaries', async () => {
    const { repo, service } = build()
    const summary = await service.addKey('workspace', WS, {
      provider: 'qwen',
      label: 'team',
      key: 'sk-secret',
    })
    expect(summary).not.toHaveProperty('key')
    expect(summary).not.toHaveProperty('keyCipher')
    expect(repo.rows[0]!.keyCipher).toBe('enc(sk-secret)')
    const listed = await service.listKeys('workspace', WS)
    expect(listed.map((k) => k.label)).toEqual(['team'])
  })

  it('lists every provider in a scope (no provider filter) in one read', async () => {
    const { service } = build()
    await service.addKey('account', ACC, { provider: 'openai', label: 'a', key: '1' })
    await service.addKey('account', ACC, { provider: 'qwen', label: 'b', key: '2' })
    const listed = await service.listKeys('account', ACC)
    expect(new Set(listed.map((k) => k.provider))).toEqual(new Set(['openai', 'qwen']))
    // Filtering by provider still narrows to one.
    expect((await service.listKeys('account', ACC, 'qwen')).map((k) => k.label)).toEqual(['b'])
  })

  it('merges workspace + owning-account + user scopes into the candidate pool', async () => {
    const { service } = build()
    await service.addKey('account', ACC, { provider: 'openai', label: 'org', key: 'a' })
    await service.addKey('user', USER, { provider: 'anthropic', label: 'mine', key: 'b' })
    // From the workspace alone, only the account-scoped openai key is visible.
    expect(await service.configuredProviders(WS)).toEqual(['openai'])
    // With the initiating user, their personal anthropic key joins the pool too.
    expect(new Set(await service.configuredProviders(WS, { userId: USER }))).toEqual(
      new Set(['openai', 'anthropic']),
    )
    expect(await service.hasKey(WS, 'anthropic', { userId: USER })).toBe(true)
    expect(await service.hasKey(WS, 'anthropic')).toBe(false)
  })

  it('leases the decrypted secret and throws when the merged pool is empty', async () => {
    const { service } = build()
    await expect(service.lease(WS, 'qwen')).rejects.toBeInstanceOf(ConflictError)
    await service.addKey('account', ACC, { provider: 'qwen', label: 'org', key: 'sk-q' })
    const leased = await service.lease(WS, 'qwen')
    expect(leased.secret).toBe('sk-q')
    expect(leased.provider).toBe('qwen')
  })

  it('wraps a decrypt failure with the provider + key id (encryption-key mismatch)', async () => {
    const repo = new FakeRepo()
    let seq = 0
    const idGenerator: IdGenerator = { next: (prefix: string) => `${prefix}_${++seq}` }
    // A cipher that fails to decrypt — the shape of a key sealed under a rotated ENCRYPTION_KEY,
    // whose raw Web Crypto failure is the opaque "operation-specific reason" DOMException.
    const cause = new Error('The operation failed for an operation-specific reason')
    const failingCipher: SecretCipher = {
      encrypt: async (plaintext) => `enc(${plaintext})`,
      decrypt: async () => {
        throw cause
      },
    }
    const service = new ApiKeyService({
      providerApiKeyRepository: repo,
      workspaceRepository,
      secretCipher: failingCipher,
      idGenerator,
      clock: { now: () => 1000 },
      usageWindowMs: WINDOW,
    })
    await service.addKey('workspace', WS, { provider: 'openrouter', label: 'k', key: 'sk-x' })
    const err = (await service.lease(WS, 'openrouter').catch((e: unknown) => e)) as Error
    // Actionable: names the offending provider + key id, and keeps the original as `cause` —
    // instead of surfacing the bare, contextless Web Crypto message.
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("'openrouter'")
    expect(err.message).toContain('apikey_1')
    expect(err.message).toContain('operation-specific reason')
    expect(err.cause).toBe(cause)
  })

  it('rotates to the least-loaded key across scopes (usage-aware)', async () => {
    const { service } = build()
    const wsKey = await service.addKey('workspace', WS, { provider: 'qwen', label: 'ws', key: '1' })
    const accKey = await service.addKey('account', ACC, {
      provider: 'qwen',
      label: 'acc',
      key: '2',
    })
    // Load up the workspace key; the next lease must pick the (unused) account key.
    await service.recordUsage(wsKey.id, { inputTokens: 5000, outputTokens: 5000 })
    const leased = await service.lease(WS, 'qwen')
    expect(leased.keyId).toBe(accKey.id)
  })

  it('soft-deletes a key out of its scope', async () => {
    const { service } = build()
    const k = await service.addKey('workspace', WS, { provider: 'qwen', label: 'ws', key: '1' })
    await service.removeKey('workspace', WS, k.id)
    expect(await service.listKeys('workspace', WS)).toEqual([])
    expect(await service.hasKey(WS, 'qwen')).toBe(false)
  })

  it('a disabled key is skipped by lease/hasKey but stays listed and re-enablable', async () => {
    const { service } = build()
    const k = await service.addKey('workspace', WS, { provider: 'qwen', label: 'ws', key: '1' })
    const updated = await service.updateKey('workspace', WS, k.id, { enabled: false })
    expect(updated.enabled).toBe(false)
    // Still visible in the management list, but not leasable / not "configured".
    expect((await service.listKeys('workspace', WS)).map((x) => x.id)).toEqual([k.id])
    expect(await service.hasKey(WS, 'qwen')).toBe(false)
    await expect(service.lease(WS, 'qwen')).rejects.toBeInstanceOf(ConflictError)
    // Re-enabling brings it back.
    await service.updateKey('workspace', WS, k.id, { enabled: true })
    expect(await service.hasKey(WS, 'qwen')).toBe(true)
    expect((await service.lease(WS, 'qwen')).secret).toBe('1')
  })

  it('a pinned default wins over usage-aware rotation until unpinned', async () => {
    const { service } = build()
    const a = await service.addKey('workspace', WS, { provider: 'qwen', label: 'a', key: '1' })
    const b = await service.addKey('workspace', WS, { provider: 'qwen', label: 'b', key: '2' })
    // Load up `a` so rotation would prefer `b`.
    await service.recordUsage(a.id, { inputTokens: 5000, outputTokens: 5000 })
    // Pin `a` as default → it is leased despite its heavier load.
    await service.updateKey('workspace', WS, a.id, { isDefault: true })
    expect((await service.lease(WS, 'qwen')).keyId).toBe(a.id)
    // Pinning `b` clears `a`'s default (at most one per group).
    await service.updateKey('workspace', WS, b.id, { isDefault: true })
    expect((await service.listKeys('workspace', WS)).find((k) => k.id === a.id)!.isDefault).toBe(
      false,
    )
    expect((await service.lease(WS, 'qwen')).keyId).toBe(b.id)
    // Unpinning reverts to usage-aware rotation (the least-loaded `b`).
    await service.updateKey('workspace', WS, b.id, { isDefault: false })
    expect((await service.lease(WS, 'qwen')).keyId).toBe(b.id)
  })
})
