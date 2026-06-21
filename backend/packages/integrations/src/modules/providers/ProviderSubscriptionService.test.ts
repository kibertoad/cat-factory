import { describe, expect, it } from 'vitest'
import { ConflictError } from '@cat-factory/kernel'
import type {
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SecretCipher,
  SubscriptionVendor,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ProviderSubscriptionService } from './ProviderSubscriptionService.js'

// Service-level behaviour over an in-memory repository: encryption-at-rest (the raw
// secret never lands in the row), usage-aware leasing + the window-reset usage
// round-trip, and the per-vendor pool cap. The pure rotation choice is covered in
// providers.logic.test; this exercises the service wiring those pieces together.

const WINDOW = 5 * 60 * 60 * 1000

/** A trivially reversible cipher so the test can assert the row holds ciphertext. */
const fakeCipher: SecretCipher = {
  encrypt: async (plaintext) => `enc(${plaintext})`,
  decrypt: async (envelope) => envelope.replace(/^enc\(([\s\S]*)\)$/, '$1'),
}

const workspaceRepository: WorkspaceRepository = {
  get: async (id) => ({ id, name: id }) as Workspace,
} as unknown as WorkspaceRepository

/** In-memory pool repo mirroring the D1/Drizzle window-reset usage semantics. */
class FakeRepo implements ProviderSubscriptionTokenRepository {
  rows: ProviderSubscriptionTokenRecord[] = []
  private live(workspaceId: string, vendor: SubscriptionVendor): ProviderSubscriptionTokenRecord[] {
    return this.rows.filter(
      (r) => r.workspaceId === workspaceId && r.vendor === vendor && r.deletedAt === null,
    )
  }
  async listByVendor(workspaceId: string, vendor: SubscriptionVendor) {
    return this.live(workspaceId, vendor).sort((a, b) => a.createdAt - b.createdAt)
  }
  async getById(workspaceId: string, id: string) {
    return (
      this.rows.find((r) => r.id === id && r.workspaceId === workspaceId && !r.deletedAt) ?? null
    )
  }
  async add(record: ProviderSubscriptionTokenRecord) {
    this.rows.push({ ...record })
  }
  async markLeased(workspaceId: string, id: string, at: number) {
    const row = await this.getById(workspaceId, id)
    if (row) row.lastUsedAt = at
  }
  async recordUsage(
    workspaceId: string,
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ) {
    const row = await this.getById(workspaceId, id)
    if (!row) return
    const active = row.windowStartedAt !== null && at - row.windowStartedAt < windowMs
    row.windowStartedAt = active ? row.windowStartedAt : at
    row.inputTokens = (active ? row.inputTokens : 0) + usage.inputTokens
    row.outputTokens = (active ? row.outputTokens : 0) + usage.outputTokens
    row.requestCount = (active ? row.requestCount : 0) + 1
  }
  async softDelete(workspaceId: string, id: string, at: number) {
    const row = await this.getById(workspaceId, id)
    if (row) row.deletedAt = at
  }
}

function makeService(repo: FakeRepo, now: () => number) {
  let counter = 0
  return new ProviderSubscriptionService({
    providerSubscriptionTokenRepository: repo,
    workspaceRepository,
    secretCipher: fakeCipher,
    idGenerator: { next: (p: string) => `${p}_${++counter}` },
    clock: { now },
    usageWindowMs: WINDOW,
  })
}

describe('ProviderSubscriptionService', () => {
  it('stores the secret encrypted at rest and never returns it', async () => {
    const repo = new FakeRepo()
    const svc = makeService(repo, () => 1000)
    const summary = await svc.addToken('ws', {
      vendor: 'claude',
      label: 'primary',
      token: 'sk-ant-oat01-raw-secret',
    })
    // The summary carries metadata only.
    expect(JSON.stringify(summary)).not.toContain('raw-secret')
    // The persisted row holds ciphertext, not the plaintext.
    expect(repo.rows[0]!.tokenCipher).toBe('enc(sk-ant-oat01-raw-secret)')
  })

  it('leases the least-loaded token and decrypts it', async () => {
    const repo = new FakeRepo()
    const svc = makeService(repo, () => 2000)
    const busy = await svc.addToken('ws', { vendor: 'claude', label: 'busy', token: 'tok-busy' })
    const idle = await svc.addToken('ws', { vendor: 'claude', label: 'idle', token: 'tok-idle' })
    await svc.recordTokenUsage('ws', busy.id, { inputTokens: 900, outputTokens: 100 })

    const leased = await svc.leaseToken('ws', 'claude')
    expect(leased.tokenId).toBe(idle.id)
    expect(leased.secret).toBe('tok-idle') // decrypted on lease
  })

  it('throws a ConflictError when the pool is empty', async () => {
    const svc = makeService(new FakeRepo(), () => 0)
    await expect(svc.leaseToken('ws', 'codex')).rejects.toBeInstanceOf(ConflictError)
  })

  it('accumulates usage within a window and resets once it ages out', async () => {
    const repo = new FakeRepo()
    let t = 1000
    const svc = makeService(repo, () => t)
    const { id } = await svc.addToken('ws', { vendor: 'glm', label: 'a', token: 'k' })

    await svc.recordTokenUsage('ws', id, { inputTokens: 10, outputTokens: 5 })
    t = 2000
    await svc.recordTokenUsage('ws', id, { inputTokens: 20, outputTokens: 5 })
    let listed = (await svc.listTokens('ws', 'glm'))[0]!
    expect(listed.inputTokens).toBe(30)
    expect(listed.outputTokens).toBe(10)
    expect(listed.requestCount).toBe(2)

    // Past the window: the next record resets the counters to this run only.
    t = 1000 + WINDOW + 1
    await svc.recordTokenUsage('ws', id, { inputTokens: 7, outputTokens: 3 })
    listed = (await svc.listTokens('ws', 'glm'))[0]!
    expect(listed.inputTokens).toBe(7)
    expect(listed.requestCount).toBe(1)
  })

  it('caps the pool per vendor and rejects further tokens with a ConflictError', async () => {
    const repo = new FakeRepo()
    const svc = makeService(repo, () => 0)
    for (let i = 0; i < 25; i++) {
      await svc.addToken('ws', { vendor: 'kimi', label: `t${i}`, token: `k${i}` })
    }
    await expect(
      svc.addToken('ws', { vendor: 'kimi', label: 'one-too-many', token: 'k' }),
    ).rejects.toBeInstanceOf(ConflictError)
    // A different vendor is unaffected by another vendor's full pool.
    await expect(
      svc.addToken('ws', { vendor: 'claude', label: 'ok', token: 'k' }),
    ).resolves.toBeTruthy()
  })
})
