import type { BinaryArtifactStore, BinaryBlobBackend } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the binary-artifact storage abstraction. The METADATA
// store differs per runtime (D1 on Cloudflare, Drizzle/Postgres on Node); the bytes
// in this suite live in an in-memory blob backend (real R2/S3 are covered by targeted
// integration tests, not the cross-runtime suite). Each runtime composes its REAL
// metadata store with {@link MemoryBinaryBlobBackend} via `createBinaryArtifactStore`
// and runs the SAME store → get → list → delete assertions, so a column mapped or an
// ordering computed differently fails a test instead of shipping.

/** In-memory {@link BinaryBlobBackend} for tests/conformance. */
export class MemoryBinaryBlobBackend implements BinaryBlobBackend {
  readonly kind = 'memory' as const
  private readonly blobs = new Map<string, Uint8Array>()

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes)
    return Promise.resolve()
  }

  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.blobs.get(key) ?? null)
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key)
    return Promise.resolve()
  }
}

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])

/**
 * Assert a runtime's {@link BinaryArtifactStore} (real metadata store + in-memory
 * blob backend) behaves identically across runtimes. `makeStore` builds a store over
 * the runtime's real database; ids are unique per case so the shared DB stays isolated.
 */
export function defineBinaryArtifactsSuite(
  name: string,
  makeStore: () => BinaryArtifactStore,
): void {
  describe(`[${name}] binary artifact store parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}`, blk: `blk-${tag}` }
    }

    it('stores a blob + metadata and reads both back', async () => {
      const store = makeStore()
      const { ws, e1, blk } = ids()
      const bytes = png(1)
      const rec = await store.store({
        meta: {
          workspaceId: ws,
          executionId: e1,
          blockId: blk,
          kind: 'screenshot',
          view: 'login',
          contentType: 'image/png',
        },
        blob: bytes,
      })
      expect(rec.id).toBeTruthy()
      expect(rec.byteSize).toBe(bytes.byteLength)
      expect(rec.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(rec.storage).toBe('memory')

      const meta = await store.getMetadata(ws, rec.id)
      expect(meta).toEqual(rec)

      const blob = await store.getBlob(ws, rec.id)
      expect(blob).toEqual(bytes)
    })

    it('lists a run’s artifacts oldest-first and scopes by execution', async () => {
      const store = makeStore()
      const { ws, e1, e2, blk } = ids()
      const mk = (executionId: string, view: string, n: number) =>
        store.store({
          meta: {
            workspaceId: ws,
            executionId,
            blockId: blk,
            kind: 'screenshot',
            view,
            contentType: 'image/png',
          },
          blob: png(n),
        })
      const a = await mk(e1, 'a', 1)
      const b = await mk(e1, 'b', 2)
      await mk(e2, 'c', 3)

      const list = await store.listByExecution(ws, e1)
      expect(list.map((r) => r.id)).toEqual([a.id, b.id])
      expect(list.map((r) => r.view)).toEqual(['a', 'b'])
      // The other run's artifact is excluded.
      expect((await store.listByExecution(ws, e2)).map((r) => r.view)).toEqual(['c'])
    })

    it('round-trips a reference artifact (block-scoped, no execution) and lists by block', async () => {
      const store = makeStore()
      const { ws, blk } = ids()
      const rec = await store.store({
        meta: {
          workspaceId: ws,
          executionId: null,
          blockId: blk,
          kind: 'reference',
          view: 'dashboard',
          contentType: 'image/png',
        },
        blob: png(7),
      })
      const meta = await store.getMetadata(ws, rec.id)
      expect(meta?.kind).toBe('reference')
      expect(meta?.executionId).toBeNull()
      // listByBlock finds it even though it carries no executionId (the reference-design
      // upload path the visual-confirmation gate reads).
      const byBlock = await store.listByBlock(ws, blk)
      expect(byBlock.map((r) => r.id)).toEqual([rec.id])
    })

    it('deletes a stored artifact (metadata + bytes)', async () => {
      const store = makeStore()
      const { ws, e1, blk } = ids()
      const rec = await store.store({
        meta: {
          workspaceId: ws,
          executionId: e1,
          blockId: blk,
          kind: 'screenshot',
          view: 'v',
          contentType: 'image/png',
        },
        blob: png(9),
      })
      await store.delete(ws, rec.id)
      expect(await store.getMetadata(ws, rec.id)).toBeNull()
      expect(await store.getBlob(ws, rec.id)).toBeNull()
      expect(await store.listByExecution(ws, e1)).toEqual([])
    })
  })
}
