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

function build(scopeHeader?: string) {
  const repo = new FakeRepo()
  const service = new UserSecretService({
    userSecretRepository: repo,
    secretCipher: systemCipher,
    clock: { now: () => 1000 },
    // Stub fetch so the github_pat test probe is deterministic. `x-oauth-scopes` is what
    // GitHub reports a CLASSIC token's grant on, and the probe classifies the token's reach
    // from it (see `githubPatScope.ts`).
    fetch: (async (url: string) =>
      new Response(JSON.stringify({ login: 'octocat' }), {
        status: url.includes('/user') ? 200 : 404,
        ...(scopeHeader ? { headers: { 'x-oauth-scopes': scopeHeader } } : {}),
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

  it('tests a github_pat by probing GET /user and states the token reach', async () => {
    const { service } = build('repo, workflow')
    const result = await service.testConnection('github_pat', { secret: 'ghp_abc' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Authenticated as octocat')
    // The verdict line carries the breadth, and the account-wide grant is a WARNING beside it
    // rather than a failure — the token is valid, which is exactly why it was invisible before.
    expect(result.message).toContain('repo, workflow')
    expect(result.warnings?.map((w) => w.code)).toEqual(['github_pat_classic_account_wide'])
  })

  it('reports no breadth warning for a fine-grained token', async () => {
    // GitHub sends no scope header for fine-grained tokens; they are repository-scoped by
    // construction, so the form must stay quiet rather than nag on every save.
    const { service } = build()
    const result = await service.testConnection('github_pat', { secret: 'github_pat_11ABC' })
    expect(result.ok).toBe(true)
    expect(result.warnings).toBeUndefined()
  })

  it('fires onSecretChanged after a store and a remove (viewer-repos cache invalidation)', async () => {
    const repo = new FakeRepo()
    const changes: { userId: string; kind: string }[] = []
    const service = new UserSecretService({
      userSecretRepository: repo,
      secretCipher: systemCipher,
      clock: { now: () => 1000 },
      onSecretChanged: (userId, kind) => void changes.push({ userId, kind }),
    })
    await service.store('usr_1', 'github_pat', { secret: 'ghp_abc' })
    await service.remove('usr_1', 'github_pat')
    expect(changes).toEqual([
      { userId: 'usr_1', kind: 'github_pat' },
      { userId: 'usr_1', kind: 'github_pat' },
    ])
  })

  it('does not fail the write when onSecretChanged throws (best-effort invalidation)', async () => {
    const repo = new FakeRepo()
    // A cache invalidation that can't reach a peer (e.g. a notification-bus failure) must not
    // surface as a failed store/remove — the write has already committed.
    const service = new UserSecretService({
      userSecretRepository: repo,
      secretCipher: systemCipher,
      clock: { now: () => 1000 },
      onSecretChanged: async () => {
        throw new Error('invalidation bus unreachable')
      },
    })
    await expect(
      service.store('usr_1', 'github_pat', { secret: 'ghp_abc' }),
    ).resolves.toMatchObject({ kind: 'github_pat', hasSecret: true })
    // The secret persisted despite the hook throwing...
    expect(await service.get('usr_1', 'github_pat')).toMatchObject({ hasSecret: true })
    // ...and remove likewise completes.
    await expect(service.remove('usr_1', 'github_pat')).resolves.toBeUndefined()
    expect(await service.get('usr_1', 'github_pat')).toBeNull()
  })
})
