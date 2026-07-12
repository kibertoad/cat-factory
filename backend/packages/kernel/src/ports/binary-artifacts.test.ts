import { describe, expect, it, vi } from 'vitest'
import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  BinaryBlobBackend,
} from './binary-artifacts.js'
import { createBinaryArtifactStore } from './binary-artifacts.js'

// Focused coverage for the shared `reclaim` fail-safe that drives BOTH `pruneOlderThan` and
// `deleteByWorkspace`. The cross-runtime conformance suite only ever exercises the all-succeed
// fast path (its in-memory blob backend never throws), so the partial-failure branch — the one
// that decides whether the bytes leak — is pinned HERE against a blob backend that can be made
// to throw for a chosen key.

/** An in-memory metadata store — just enough of the port for the reclaim paths. */
class FakeMetadataStore implements BinaryArtifactMetadataStore {
  readonly rows = new Map<string, BinaryArtifactRecord>()

  insert(record: BinaryArtifactRecord): Promise<void> {
    this.rows.set(record.id, record)
    return Promise.resolve()
  }
  get(_workspaceId: string, id: string): Promise<BinaryArtifactRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null)
  }
  listByExecution(): Promise<BinaryArtifactRecord[]> {
    return Promise.resolve([])
  }
  countByExecution(): Promise<number> {
    return Promise.resolve(0)
  }
  listByBlock(): Promise<BinaryArtifactRecord[]> {
    return Promise.resolve([])
  }
  delete(_workspaceId: string, id: string): Promise<void> {
    this.rows.delete(id)
    return Promise.resolve()
  }
  listOlderThan(workspaceId: string): Promise<BinaryArtifactRecord[]> {
    return this.listByWorkspace(workspaceId)
  }
  deleteOlderThan(workspaceId: string): Promise<number> {
    return this.deleteByWorkspace(workspaceId)
  }
  listByWorkspace(workspaceId: string): Promise<BinaryArtifactRecord[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.workspaceId === workspaceId))
  }
  deleteByWorkspace(workspaceId: string): Promise<number> {
    let n = 0
    for (const [id, r] of this.rows) {
      if (r.workspaceId === workspaceId) {
        this.rows.delete(id)
        n += 1
      }
    }
    return Promise.resolve(n)
  }
}

/** A blob backend whose `delete` throws for any key in `failKeys`. */
class FlakyBlobBackend implements BinaryBlobBackend {
  readonly kind = 'memory' as const
  readonly blobs = new Map<string, Uint8Array>()
  constructor(private readonly failKeys: Set<string>) {}

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes)
    return Promise.resolve()
  }
  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.blobs.get(key) ?? null)
  }
  delete(key: string): Promise<void> {
    if (this.failKeys.has(key)) return Promise.reject(new Error(`blob backend down: ${key}`))
    this.blobs.delete(key)
    return Promise.resolve()
  }
}

const deps = (metadata: FakeMetadataStore, blob: BinaryBlobBackend, logger?: unknown) => {
  let seq = 0
  return {
    metadata,
    blob,
    idGenerator: { next: (p: string) => `${p}-${(seq += 1)}` },
    clock: { now: () => 1000 },
    ...(logger ? { logger: logger as { warn(o: Record<string, unknown>, m?: string): void } } : {}),
  }
}

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])
const meta = (workspaceId: string, n: number) => ({
  workspaceId,
  executionId: null,
  blockId: null,
  kind: 'screenshot' as const,
  view: `v${n}`,
  contentType: 'image/png',
})

describe('createBinaryArtifactStore reclaim (fail-safe partial-failure branch)', () => {
  it('deleteByWorkspace retains the row whose blob delete failed and removes the rest', async () => {
    const metadata = new FakeMetadataStore()
    // Fail the SECOND artifact's blob (key is `${workspaceId}/${id}`, id = `art-2`).
    const blob = new FlakyBlobBackend(new Set(['ws/art-2']))
    const logger = { warn: vi.fn() }
    const store = createBinaryArtifactStore(deps(metadata, blob, logger))

    const a = await store.store({ meta: meta('ws', 1), blob: png(1) })
    const b = await store.store({ meta: meta('ws', 2), blob: png(2) })
    const c = await store.store({ meta: meta('ws', 3), blob: png(3) })

    const removed = await store.deleteByWorkspace('ws')

    // Only the two whose bytes are confirmed gone are reported removed.
    expect(removed).toBe(2)
    // The failed artifact keeps BOTH its metadata row and its bytes (the handle survives).
    expect(await store.getMetadata('ws', b.id)).not.toBeNull()
    expect(blob.blobs.has(b.storageKey)).toBe(true)
    // The others are fully reclaimed (row + bytes).
    for (const rec of [a, c]) {
      expect(await store.getMetadata('ws', rec.id)).toBeNull()
      expect(blob.blobs.has(rec.storageKey)).toBe(false)
    }
    // The residual leak is surfaced, not silent.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'ws', failed: 1, total: 3 })
  })

  it('takes the bulk fast path (no per-row deletes, no warning) when every blob deletes', async () => {
    const metadata = new FakeMetadataStore()
    const blob = new FlakyBlobBackend(new Set())
    const logger = { warn: vi.fn() }
    const store = createBinaryArtifactStore(deps(metadata, blob, logger))
    await store.store({ meta: meta('ws', 1), blob: png(1) })
    await store.store({ meta: meta('ws', 2), blob: png(2) })

    expect(await store.deleteByWorkspace('ws')).toBe(2)
    expect(metadata.rows.size).toBe(0)
    expect(blob.blobs.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('pruneOlderThan shares the same partial-failure fail-safe', async () => {
    const metadata = new FakeMetadataStore()
    const blob = new FlakyBlobBackend(new Set(['ws/art-1']))
    const store = createBinaryArtifactStore(deps(metadata, blob))
    const a = await store.store({ meta: meta('ws', 1), blob: png(1) })
    const b = await store.store({ meta: meta('ws', 2), blob: png(2) })

    const removed = await store.pruneOlderThan('ws', 9999)
    expect(removed).toBe(1)
    expect(await store.getMetadata('ws', a.id)).not.toBeNull() // failed blob → row retained
    expect(await store.getMetadata('ws', b.id)).toBeNull()
  })
})
