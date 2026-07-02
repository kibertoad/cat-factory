import type { PublicApiKeyRecord, PublicApiKeyRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { PublicApiKeyService } from './PublicApiKeyService.js'

// In-memory repository — the service's hashing/auth logic is what's under test, not persistence.
class FakeRepo implements PublicApiKeyRepository {
  rows = new Map<string, PublicApiKeyRecord>()
  add(r: PublicApiKeyRecord) {
    this.rows.set(r.id, { ...r })
    return Promise.resolve()
  }
  getById(id: string) {
    const r = this.rows.get(id)
    return Promise.resolve(r ? { ...r } : null)
  }
  listByWorkspace(workspaceId: string) {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.workspaceId === workspaceId && r.revokedAt === null),
    )
  }
  markUsed(id: string, at: number) {
    const r = this.rows.get(id)
    if (r) r.lastUsedAt = at
    return Promise.resolve()
  }
  revoke(workspaceId: string, id: string, at: number) {
    const r = this.rows.get(id)
    if (r && r.workspaceId === workspaceId && r.revokedAt === null) r.revokedAt = at
    return Promise.resolve()
  }
}

function makeService(now = { t: 1000 }) {
  const repo = new FakeRepo()
  let n = 0
  const service = new PublicApiKeyService({
    repository: repo,
    pepper: 'a-test-pepper',
    idGenerator: { next: (prefix?: string) => `${prefix ?? 'id'}_${(n++).toString(16)}` },
    clock: { now: () => now.t },
  })
  return { service, repo, now }
}

describe('PublicApiKeyService', () => {
  it('issues a key that authenticates back to its scope, and stores only a hash', async () => {
    const { service, repo } = makeService()
    const { record, secret } = await service.issue(
      { accountId: 'acc_1', workspaceId: 'ws_1' },
      'external system',
    )
    expect(secret).toMatch(/^cf_live_pak_[0-9a-f]+\.[0-9a-f]+$/)
    // The stored secret is a hash, never the raw secret.
    const stored = repo.rows.get(record.id)!
    expect(stored.secretHash).not.toContain(secret)
    expect(secret).not.toContain(stored.secretHash)

    const auth = await service.authenticate(secret)
    expect(auth).toEqual({ keyId: record.id, accountId: 'acc_1', workspaceId: 'ws_1' })
  })

  it('rejects a wrong secret, a malformed key, and an unknown id', async () => {
    const { service } = makeService()
    const { record, secret } = await service.issue({ accountId: 'a', workspaceId: 'w' }, 'k')
    const goodSuffix = secret.split('.')[1]

    expect(await service.authenticate(undefined)).toBeNull()
    expect(await service.authenticate('nonsense')).toBeNull()
    expect(await service.authenticate('cf_live_')).toBeNull()
    expect(await service.authenticate(`cf_live_${record.id}`)).toBeNull() // no secret part
    expect(await service.authenticate(`cf_live_${record.id}.deadbeef`)).toBeNull() // wrong secret
    expect(await service.authenticate(`cf_live_pak_unknown.${goodSuffix}`)).toBeNull() // unknown id
  })

  it('stops authenticating once revoked, and revocation is workspace-scoped', async () => {
    const { service } = makeService()
    const { record, secret } = await service.issue({ accountId: 'a', workspaceId: 'w' }, 'k')
    expect(await service.authenticate(secret)).not.toBeNull()

    // A revoke scoped to a different workspace is a no-op.
    await service.revoke('other-ws', record.id)
    expect(await service.authenticate(secret)).not.toBeNull()

    await service.revoke('w', record.id)
    expect(await service.authenticate(secret)).toBeNull()
    // A revoked key drops out of the management list.
    expect(await service.list('w')).toHaveLength(0)
  })
})
