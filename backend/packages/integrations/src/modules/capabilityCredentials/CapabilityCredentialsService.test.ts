import { describe, expect, it } from 'vitest'
import type {
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
  Clock,
  SecretCipher,
} from '@cat-factory/kernel'
import { CapabilityCredentialsService } from './CapabilityCredentialsService.js'

// A reversible "cipher" that tags the plaintext, so a test can assert the stored blob is sealed
// (not raw JSON) while still round-tripping through decrypt.
const fakeCipher: SecretCipher = {
  encrypt: (plaintext) => Promise.resolve(`sealed:${plaintext}`),
  decrypt: (envelope) => Promise.resolve(envelope.replace(/^sealed:/, '')),
}

class MemoryRepository implements CapabilityCredentialRepository {
  readonly rows = new Map<string, CapabilityCredentialRecord>()
  get(workspaceId: string) {
    return Promise.resolve(this.rows.get(workspaceId) ?? null)
  }
  upsert(record: CapabilityCredentialRecord) {
    this.rows.set(record.workspaceId, record)
    return Promise.resolve()
  }
  delete(workspaceId: string) {
    this.rows.delete(workspaceId)
    return Promise.resolve()
  }
}

function makeService(repo: CapabilityCredentialRepository, now = 1000) {
  const clock: Clock = { now: () => now }
  return new CapabilityCredentialsService({
    capabilityCredentialRepository: repo,
    secretCipher: fakeCipher,
    clock,
  })
}

describe('CapabilityCredentialsService.put', () => {
  it('adds a credential without disturbing the ones already stored', async () => {
    // The whole point of the narrow write: a checklist UI holds no values, so filling in the
    // second key must not cost the first one. Through `set` this is unexpressible.
    const repo = new MemoryRepository()
    const svc = makeService(repo)
    await svc.set('ws', { entries: [{ key: 'FIRST_TOKEN', value: 'one' }] })

    await svc.put('ws', 'SECOND_TOKEN', 'two')

    expect(await svc.resolveValues('ws')).toEqual([
      { key: 'FIRST_TOKEN', value: 'one' },
      { key: 'SECOND_TOKEN', value: 'two' },
    ])
  })

  it('replaces a known key in place rather than reordering the set', async () => {
    const repo = new MemoryRepository()
    const svc = makeService(repo)
    await svc.set('ws', {
      entries: [
        { key: 'FIRST_TOKEN', value: 'one' },
        { key: 'SECOND_TOKEN', value: 'two' },
      ],
    })

    await svc.put('ws', 'FIRST_TOKEN', 'rotated')

    expect(await svc.resolveValues('ws')).toEqual([
      { key: 'FIRST_TOKEN', value: 'rotated' },
      { key: 'SECOND_TOKEN', value: 'two' },
    ])
  })

  it('seals the blob and answers with the non-secret summary only', async () => {
    const repo = new MemoryRepository()
    const svc = makeService(repo, 4242)

    const summary = await svc.put('ws', 'FIRST_TOKEN', 'one')

    expect(summary).toEqual([{ key: 'FIRST_TOKEN', updatedAt: 4242 }])
    expect(repo.rows.get('ws')?.credentials.startsWith('sealed:')).toBe(true)
    expect(repo.rows.get('ws')?.summary).not.toContain('one')
  })

  it('holds the per-workspace ceiling the whole-set write holds', async () => {
    // The cap lives on the whole-set schema, which the per-key write does not go through. Left
    // unguarded, the narrow path is simply a way around it.
    const repo = new MemoryRepository()
    const svc = makeService(repo)
    await svc.set('ws', {
      entries: Array.from({ length: 100 }, (_, i) => ({ key: `TOKEN_${i}`, value: 'x' })),
    })

    await expect(svc.put('ws', 'ONE_TOO_MANY', 'x')).rejects.toThrow(/at most 100/)
    // A key already stored is a REPLACE, so the cap must not refuse a rotation at the ceiling.
    await expect(svc.put('ws', 'TOKEN_0', 'rotated')).resolves.toHaveLength(100)
  })

  it('keeps the original creation timestamp on a later edit', async () => {
    const repo = new MemoryRepository()
    await makeService(repo, 1000).put('ws', 'FIRST_TOKEN', 'one')
    await makeService(repo, 2000).put('ws', 'SECOND_TOKEN', 'two')

    expect(repo.rows.get('ws')?.createdAt).toBe(1000)
    expect(repo.rows.get('ws')?.updatedAt).toBe(2000)
  })
})
