import { describe, expect, it } from 'vitest'
import type { SecretCipher, UserSecretRecord, UserSecretRepository } from '@cat-factory/kernel'
import { UserSecretService } from './UserSecretService.js'

// Service behaviour over an in-memory repo + a reversible cipher: store/list/remove,
// system-encrypted-at-rest resolution (the basis for ResolveUserGitHubToken), the
// metadata round-trip, and the github_pat kind's descriptor + test probe.

const systemCipher: SecretCipher = {
  encrypt: async (p) => `enc(${p})`,
  decrypt: async (e) => e.replace(/^enc\(([\s\S]*)\)$/, '$1'),
}

class FakeRepo implements UserSecretRepository {
  rows: UserSecretRecord[] = []
  async listByUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId)
  }
  async getByUserKind(userId: string, kind: string) {
    return this.rows.find((r) => r.userId === userId && r.kind === kind) ?? null
  }
  async upsert(record: UserSecretRecord) {
    this.rows = [
      ...this.rows.filter((r) => !(r.userId === record.userId && r.kind === record.kind)),
      record,
    ]
  }
  async remove(userId: string, kind: string) {
    this.rows = this.rows.filter((r) => !(r.userId === userId && r.kind === kind))
  }
}

function build() {
  const repo = new FakeRepo()
  const service = new UserSecretService({
    userSecretRepository: repo,
    secretCipher: systemCipher,
    clock: { now: () => 1000 },
    // Stub fetch so the github_pat test probe is deterministic.
    fetch: (async (url: string) =>
      new Response(JSON.stringify({ login: 'octocat' }), {
        status: url.includes('/user') ? 200 : 404,
      })) as unknown as typeof fetch,
  })
  return { repo, service }
}

describe('UserSecretService', () => {
  it('stores the secret system-encrypted and never returns it; resolve decrypts it', async () => {
    const { repo, service } = build()
    const status = await service.store('usr_1', 'github_pat', {
      secret: 'ghp_abc',
      metadata: { apiBase: 'https://ghe.example/api/v3' },
    })
    expect(status).toMatchObject({ kind: 'github_pat', hasSecret: true })
    expect(status).not.toHaveProperty('secret')
    expect(repo.rows[0]!.secretCipher).toBe('enc(ghp_abc)')
    expect(JSON.parse(repo.rows[0]!.metadataJson!)).toEqual({
      apiBase: 'https://ghe.example/api/v3',
    })
    expect(await service.resolve('usr_1', 'github_pat')).toBe('ghp_abc')
  })

  it('surfaces metadata in the status and resolves null for an unknown user', async () => {
    const { service } = build()
    await service.store('usr_1', 'github_pat', { secret: 'ghp_abc', metadata: { apiBase: 'x' } })
    const [status] = await service.list('usr_1')
    expect(status!.metadata).toEqual({ apiBase: 'x' })
    expect(await service.resolve('usr_2', 'github_pat')).toBeNull()
  })

  it('removes a secret', async () => {
    const { service } = build()
    await service.store('usr_1', 'github_pat', { secret: 'ghp_abc' })
    await service.remove('usr_1', 'github_pat')
    expect(await service.get('usr_1', 'github_pat')).toBeNull()
  })

  it('describes the github_pat kind (a single secret token field, test supported)', () => {
    const { service } = build()
    const descriptor = service.describe('github_pat')
    expect(descriptor?.supportsTest).toBe(true)
    expect(descriptor?.configFields.find((f) => f.secret)?.key).toBe('token')
    expect(descriptor?.configFields.map((f) => f.key)).toEqual(['token'])
  })

  it('tests a github_pat by probing GET /user', async () => {
    const { service } = build()
    const result = await service.testConnection('github_pat', { secret: 'ghp_abc' })
    expect(result).toEqual({ ok: true, message: 'Authenticated as octocat' })
  })
})
