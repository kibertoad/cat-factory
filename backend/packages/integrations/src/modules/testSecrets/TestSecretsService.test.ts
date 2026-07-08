import { describe, expect, it } from 'vitest'
import type {
  Block,
  BlockRepository,
  Clock,
  SecretCipher,
  TestSecretRecord,
  TestSecretsRepository,
} from '@cat-factory/kernel'
import { TestSecretsService } from './TestSecretsService.js'

// A reversible "cipher" that tags the plaintext so a test can assert the stored blob is sealed
// (not the raw JSON) while still round-tripping through decrypt.
const fakeCipher: SecretCipher = {
  encrypt: (plaintext) => Promise.resolve(`sealed:${plaintext}`),
  decrypt: (envelope) => Promise.resolve(envelope.replace(/^sealed:/, '')),
}

const clock: Clock = { now: () => 1000 }

class MemoryTestSecretsRepository implements TestSecretsRepository {
  readonly rows = new Map<string, TestSecretRecord>()
  private key(w: string, b: string) {
    return `${w}::${b}`
  }
  getByBlock(workspaceId: string, blockId: string) {
    return Promise.resolve(this.rows.get(this.key(workspaceId, blockId)) ?? null)
  }
  listByWorkspace(workspaceId: string) {
    return Promise.resolve([...this.rows.values()].filter((r) => r.workspaceId === workspaceId))
  }
  upsert(record: TestSecretRecord) {
    this.rows.set(this.key(record.workspaceId, record.blockId), record)
    return Promise.resolve()
  }
  deleteByBlock(workspaceId: string, blockId: string) {
    this.rows.delete(this.key(workspaceId, blockId))
    return Promise.resolve()
  }
}

function blockRepo(blocks: Block[]): BlockRepository {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  return {
    get: (_ws, id) => Promise.resolve(byId.get(id) ?? null),
  } as unknown as BlockRepository
}

function frame(id: string): Block {
  return { id, level: 'frame', parentId: null } as unknown as Block
}
function task(id: string, parentId: string): Block {
  return { id, level: 'task', parentId } as unknown as Block
}

function makeService(repo: TestSecretsRepository, blocks: Block[]) {
  return new TestSecretsService({
    testSecretsRepository: repo,
    secretCipher: fakeCipher,
    blockRepository: blockRepo(blocks),
    clock,
  })
}

describe('TestSecretsService', () => {
  it('seals the values, stores a non-secret summary, and returns redacted refs', async () => {
    const repo = new MemoryTestSecretsRepository()
    const svc = makeService(repo, [frame('svc')])

    const view = await svc.set('ws', 'svc', {
      entries: [
        { key: 'STRIPE_API_KEY', description: 'Stripe key', value: 'sk_test_123' },
        { key: 'OTHER', description: '', value: 'raw-secret' },
      ],
    })
    // The view carries only key + description — never a value.
    expect(view).toEqual({
      blockId: 'svc',
      entries: [
        { key: 'STRIPE_API_KEY', description: 'Stripe key' },
        { key: 'OTHER', description: '' },
      ],
    })

    const row = await repo.getByBlock('ws', 'svc')
    // The credentials column is sealed (not raw JSON) and the summary is value-free.
    expect(row?.credentials.startsWith('sealed:')).toBe(true)
    expect(row?.summary).not.toContain('sk_test_123')
    expect(row?.summary).not.toContain('raw-secret')
    expect(row?.createdAt).toBe(1000)

    // getView reads back the same redacted refs.
    expect(await svc.getView('ws', 'svc')).toEqual(view)
  })

  it('decrypts the full entries for dispatch (values recovered), walking to the service frame', async () => {
    const repo = new MemoryTestSecretsRepository()
    // A task under a module under the frame — resolution must walk up to `svc`.
    const svc = makeService(repo, [frame('svc'), task('mod', 'svc'), task('t1', 'mod')])
    await svc.set('ws', 'svc', {
      entries: [{ key: 'STRIPE_API_KEY', description: 'Stripe key', value: 'sk_test_123' }],
    })

    // The engine advertises only refs (no value) — resolved from the task, walking to the frame.
    expect(await svc.resolveRefsForBlock('ws', 't1')).toEqual([
      { key: 'STRIPE_API_KEY', description: 'Stripe key' },
    ])
    // The executor resolves the decrypted values — again from the task, walking to the frame.
    expect(await svc.resolveValuesForBlock('ws', 't1')).toEqual([
      { key: 'STRIPE_API_KEY', description: 'Stripe key', value: 'sk_test_123' },
    ])
    // A block whose frame has no secrets resolves to nothing (no throw).
    const other = makeService(new MemoryTestSecretsRepository(), [frame('svc')])
    expect(await other.resolveValuesForBlock('ws', 'svc')).toEqual([])
    expect(await other.resolveRefsForBlock('ws', 'svc')).toEqual([])
  })

  it('deletes the row when set to an empty entry list', async () => {
    const repo = new MemoryTestSecretsRepository()
    const svc = makeService(repo, [frame('svc')])
    await svc.set('ws', 'svc', {
      entries: [{ key: 'K', description: '', value: 'v-secret' }],
    })
    expect(await repo.getByBlock('ws', 'svc')).not.toBeNull()

    const cleared = await svc.set('ws', 'svc', { entries: [] })
    expect(cleared).toEqual({ blockId: 'svc', entries: [] })
    expect(await repo.getByBlock('ws', 'svc')).toBeNull()
  })
})
