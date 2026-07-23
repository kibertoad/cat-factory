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
// round-trip, the per-vendor pool cap, and the rule that an individual-usage vendor
// (Claude / GLM / ChatGPT-Codex) is never poolable. The pure rotation choice is covered in
// providers.logic.test; this exercises the service wiring those pieces together.

const WINDOW = 5 * 60 * 60 * 1000

/** A trivially reversible cipher so the test can assert the row holds ciphertext. */
const fakeCipher: SecretCipher = {
  encrypt: async (plaintext) => `enc(${plaintext})`,
  decrypt: async (envelope) => envelope.replace(/^enc\(([\s\S]*)\)$/, '$1'),
}

const workspaceRepository: WorkspaceRepository = {
  get: async (id: string) => ({ id, name: id }) as Workspace,
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
  async setEnabled(workspaceId: string, id: string, enabled: boolean) {
    const row = await this.getById(workspaceId, id)
    if (row) row.enabled = enabled
  }
  async setDefault(workspaceId: string, vendor: SubscriptionVendor, id: string | null) {
    for (const r of this.live(workspaceId, vendor)) {
      r.isDefault = id !== null && r.id === id
    }
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
      vendor: 'kimi',
      label: 'primary',
      token: 'kimi-coding-plan-raw-secret',
    })
    // The summary carries metadata only.
    expect(JSON.stringify(summary)).not.toContain('raw-secret')
    // The persisted row holds ciphertext, not the plaintext.
    expect(repo.rows[0]!.tokenCipher).toContain('enc(')
  })

  it('leases the least-loaded token and decrypts it', async () => {
    const repo = new FakeRepo()
    const svc = makeService(repo, () => 2000)
    const busy = await svc.addToken('ws', { vendor: 'kimi', label: 'busy', token: 'tok-busy' })
    const idle = await svc.addToken('ws', { vendor: 'kimi', label: 'idle', token: 'tok-idle' })
    await svc.recordTokenUsage('ws', busy.id, { inputTokens: 900, outputTokens: 100 })

    const leased = await svc.leaseToken('ws', 'kimi')
    expect(leased.tokenId).toBe(idle.id)
    expect(leased.secret).toBe('tok-idle') // decrypted on lease
  })

  it('throws a ConflictError when the pool is empty', async () => {
    const svc = makeService(new FakeRepo(), () => 0)
    await expect(svc.leaseToken('ws', 'kimi')).rejects.toBeInstanceOf(ConflictError)
  })

  it('skips a disabled token for lease/hasToken but keeps it listed', async () => {
    const repo = new FakeRepo()
    const svc = makeService(repo, () => 1000)
    const a = await svc.addToken('ws', { vendor: 'kimi', label: 'a', token: 'tok-a' })
    await svc.addToken('ws', { vendor: 'kimi', label: 'b', token: 'tok-b' })
    const updated = await svc.updateToken('ws', a.id, { enabled: false })
    expect(updated.enabled).toBe(false)
    // Still listed, but never leased (only `b` is eligible).
    expect((await svc.listTokens('ws', 'kimi')).map((c) => c.id)).toContain(a.id)
    expect((await svc.leaseToken('ws', 'kimi')).secret).toBe('tok-b')
    // Disabling the last enabled token makes the vendor unavailable.
    await svc.updateToken('ws', a.id, { enabled: true })
    const b = (await svc.listTokens('ws', 'kimi')).find((c) => c.label === 'b')!
    await svc.updateToken('ws', a.id, { enabled: false })
    await svc.updateToken('ws', b.id, { enabled: false })
    expect(await svc.hasToken('ws', 'kimi')).toBe(false)
    await expect(svc.leaseToken('ws', 'kimi')).rejects.toBeInstanceOf(ConflictError)
  })

  it('leases a pinned default over the least-loaded token, and clears it on unpin', async () => {
    const repo = new FakeRepo()
    const svc = makeService(repo, () => 1000)
    const busy = await svc.addToken('ws', { vendor: 'kimi', label: 'busy', token: 'tok-busy' })
    await svc.addToken('ws', { vendor: 'kimi', label: 'idle', token: 'tok-idle' })
    await svc.recordTokenUsage('ws', busy.id, { inputTokens: 900, outputTokens: 100 })
    // Pin the busy token: it now wins despite rotation preferring the idle one.
    await svc.updateToken('ws', busy.id, { isDefault: true })
    expect((await svc.leaseToken('ws', 'kimi')).tokenId).toBe(busy.id)
    // Unpin → rotation resumes and the idle token wins.
    await svc.updateToken('ws', busy.id, { isDefault: false })
    expect((await svc.leaseToken('ws', 'kimi')).secret).toBe('tok-idle')
  })

  it('accumulates usage within a window and resets once it ages out', async () => {
    const repo = new FakeRepo()
    let t = 1000
    const svc = makeService(repo, () => t)
    const { id } = await svc.addToken('ws', { vendor: 'kimi', label: 'a', token: 'k' })

    await svc.recordTokenUsage('ws', id, { inputTokens: 10, outputTokens: 5 })
    t = 2000
    await svc.recordTokenUsage('ws', id, { inputTokens: 20, outputTokens: 5 })
    let listed = (await svc.listTokens('ws', 'kimi'))[0]!
    expect(listed.inputTokens).toBe(30)
    expect(listed.outputTokens).toBe(10)
    expect(listed.requestCount).toBe(2)

    // Past the window: the next record resets the counters to this run only.
    t = 1000 + WINDOW + 1
    await svc.recordTokenUsage('ws', id, { inputTokens: 7, outputTokens: 3 })
    listed = (await svc.listTokens('ws', 'kimi'))[0]!
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
      svc.addToken('ws', { vendor: 'deepseek', label: 'ok', token: 'k' }),
    ).resolves.toBeTruthy()
  })

  // Claude, GLM (Z.ai Coding Plan) and ChatGPT/Codex are each licensed for individual use
  // only by their own terms, so they are NEVER poolable on a workspace — they are stored
  // per-user by PersonalSubscriptionService instead.
  describe('individual-usage vendors are not poolable', () => {
    it.each(['claude', 'glm', 'codex'] as const)(
      'refuses to add, lease, or report a %s token in the workspace pool',
      async (vendor) => {
        const repo = new FakeRepo()
        const svc = makeService(repo, () => 0)
        await expect(
          svc.addToken('ws', { vendor, label: 'x', token: 'individual-secret' }),
        ).rejects.toBeInstanceOf(ConflictError)
        await expect(svc.leaseToken('ws', vendor)).rejects.toBeInstanceOf(ConflictError)
        expect(await svc.hasToken('ws', vendor)).toBe(false)
      },
    )

    it('omits individual-usage vendors from the unfiltered pool listing', async () => {
      const repo = new FakeRepo()
      const svc = makeService(repo, () => 0)
      await svc.addToken('ws', { vendor: 'kimi', label: 'moonshot', token: 'k' })
      const listed = await svc.listTokens('ws')
      expect(listed.map((c) => c.vendor)).not.toContain('claude')
      expect(listed.map((c) => c.vendor)).not.toContain('glm')
      expect(listed.map((c) => c.vendor)).not.toContain('codex')
      expect(listed.map((c) => c.vendor)).toContain('kimi')
    })
  })
})
