import { describe, expect, it } from 'vitest'
import type {
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
  Clock,
  SecretCipher,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { CapabilityCredentialsService } from './CapabilityCredentialsService.js'

// A reversible "cipher" that tags the plaintext, so a test can assert the stored blob is sealed
// (not raw JSON) while still round-tripping through decrypt.
const fakeCipher: SecretCipher = {
  encrypt: (plaintext) => Promise.resolve(`sealed:${plaintext}`),
  decrypt: (envelope) => Promise.resolve(envelope.replace(/^sealed:/, '')),
}

// In-memory double with the REAL repos' concurrency semantics: the blind upsert bumps the stored
// rev on conflict, compareAndSwap wins only on a matching rev (null = expect no row), deleteIfRev
// likewise, so the service's retry loop is exercised against the contract it actually runs on.
class MemoryRepository implements CapabilityCredentialRepository {
  readonly rows = new Map<string, CapabilityCredentialRecord>()
  get(workspaceId: string) {
    return Promise.resolve(this.rows.get(workspaceId) ?? null)
  }
  upsert(record: CapabilityCredentialRecord) {
    const existing = this.rows.get(record.workspaceId)
    this.rows.set(
      record.workspaceId,
      existing ? { ...record, rev: existing.rev + 1 } : { ...record },
    )
    return Promise.resolve()
  }
  compareAndSwap(record: CapabilityCredentialRecord, expectedRev: number | null) {
    const existing = this.rows.get(record.workspaceId)
    if (expectedRev === null) {
      if (existing) return Promise.resolve(false)
      this.rows.set(record.workspaceId, { ...record })
      return Promise.resolve(true)
    }
    if (!existing || existing.rev !== expectedRev) return Promise.resolve(false)
    this.rows.set(record.workspaceId, { ...record })
    return Promise.resolve(true)
  }
  deleteIfRev(workspaceId: string, expectedRev: number) {
    const existing = this.rows.get(workspaceId)
    if (!existing || existing.rev !== expectedRev) return Promise.resolve(false)
    this.rows.delete(workspaceId)
    return Promise.resolve(true)
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

  it('stamps only the touched key, keeping every neighbour\'s "last set" date', async () => {
    // "Last set" is a per-key fact the panel renders per row. A write that re-stamped the whole
    // set would falsify every neighbour's date: saving key B must not move key A's.
    const repo = new MemoryRepository()
    await makeService(repo, 1000).put('ws', 'FIRST_TOKEN', 'one')

    const summary = await makeService(repo, 2000).put('ws', 'SECOND_TOKEN', 'two')

    expect(summary).toEqual([
      { key: 'FIRST_TOKEN', updatedAt: 1000 },
      { key: 'SECOND_TOKEN', updatedAt: 2000 },
    ])
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

  it("re-applies on the winner's snapshot when another writer got there first", async () => {
    // Two operators saving DIFFERENT keys at the same moment must BOTH land. A blind upsert
    // loses one silently (the loser's save returned success, so nothing ever looks wrong) and
    // the key surfaces later as a dispatch resolving nothing.
    const repo = new MemoryRepository()
    await makeService(repo, 1000).put('ws', 'BASE_TOKEN', 'base')

    const competing = makeService(repo, 1500)
    const original = repo.compareAndSwap.bind(repo)
    let raced = false
    repo.compareAndSwap = async (record, expectedRev) => {
      // A competing save lands between this writer's read and its guarded write, exactly once.
      if (!raced) {
        raced = true
        await competing.put('ws', 'THEIR_TOKEN', 'theirs')
      }
      return original(record, expectedRev)
    }

    const summary = await makeService(repo, 2000).put('ws', 'MY_TOKEN', 'mine')

    expect(await makeService(repo).resolveValues('ws')).toEqual([
      { key: 'BASE_TOKEN', value: 'base' },
      { key: 'THEIR_TOKEN', value: 'theirs' },
      { key: 'MY_TOKEN', value: 'mine' },
    ])
    // The re-applied write still keeps every untouched key's own timestamp.
    expect(summary).toEqual([
      { key: 'BASE_TOKEN', updatedAt: 1000 },
      { key: 'THEIR_TOKEN', updatedAt: 1500 },
      { key: 'MY_TOKEN', updatedAt: 2000 },
    ])
  })

  it('gives up with a 409 once the retry budget is spent on a pathological hot row', async () => {
    const repo = new MemoryRepository()
    repo.compareAndSwap = () => Promise.resolve(false)

    await expect(makeService(repo).put('ws', 'FIRST_TOKEN', 'one')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })
})

describe('CapabilityCredentialsService.remove', () => {
  it("keeps the survivors' timestamps when a sibling is removed", async () => {
    const repo = new MemoryRepository()
    await makeService(repo, 1000).put('ws', 'FIRST_TOKEN', 'one')
    await makeService(repo, 2000).put('ws', 'SECOND_TOKEN', 'two')

    const summary = await makeService(repo, 3000).remove('ws', 'FIRST_TOKEN')

    expect(summary).toEqual([{ key: 'SECOND_TOKEN', updatedAt: 2000 }])
  })

  it('deletes the row through the rev guard when the set empties', async () => {
    const repo = new MemoryRepository()
    const svc = makeService(repo)
    await svc.put('ws', 'ONLY_TOKEN', 'one')

    await expect(svc.remove('ws', 'ONLY_TOKEN')).resolves.toEqual([])

    expect(repo.rows.has('ws')).toBe(false)
  })

  it('answers with the current state on a duplicate delete instead of re-sealing', async () => {
    const repo = new MemoryRepository()
    const svc = makeService(repo, 1000)
    await svc.put('ws', 'FIRST_TOKEN', 'one')
    const sealedBefore = repo.rows.get('ws')?.credentials

    await expect(svc.remove('ws', 'NEVER_STORED')).resolves.toEqual([
      { key: 'FIRST_TOKEN', updatedAt: 1000 },
    ])
    expect(repo.rows.get('ws')?.credentials).toBe(sealedBefore)
  })
})
