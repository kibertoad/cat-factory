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
  async listByScope(scope: ApiKeyScope, scopeId: string, provider: ApiKeyProvider) {
    return this.rows
      .filter(
        (r) =>
          r.scope === scope &&
          r.scopeId === scopeId &&
          r.provider === provider &&
          r.deletedAt === null,
      )
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  async listForPool(scopes: ApiKeyScopeRef[], provider: ApiKeyProvider) {
    return this.rows
      .filter((r) => r.deletedAt === null && r.provider === provider && this.matches(r, scopes))
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  async listConfiguredProviders(scopes: ApiKeyScopeRef[]) {
    const set = new Set<ApiKeyProvider>()
    for (const r of this.rows) {
      if (r.deletedAt === null && this.matches(r, scopes)) set.add(r.provider)
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

  it('rotates to the least-loaded key across scopes (usage-aware)', async () => {
    const { service } = build()
    const wsKey = await service.addKey('workspace', WS, { provider: 'qwen', label: 'ws', key: '1' })
    const accKey = await service.addKey('account', ACC, { provider: 'qwen', label: 'acc', key: '2' })
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
})
