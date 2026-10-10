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
      // countByExecution (the per-run upload-cap precheck) agrees with the list and scopes by run.
      expect(await store.countByExecution(ws, e1)).toBe(2)
      expect(await store.countByExecution(ws, e2)).toBe(1)
    })

    it('getBlobWithMetadata returns the record + bytes in one read', async () => {
      const store = makeStore()
      const { ws, e1, blk } = ids()
      const bytes = png(5)
      const rec = await store.store({
        meta: {
          workspaceId: ws,
          executionId: e1,
          blockId: blk,
          kind: 'screenshot',
          view: 'v',
          contentType: 'image/png',
        },
        blob: bytes,
      })
      const got = await store.getBlobWithMetadata(ws, rec.id)
      expect(got?.record).toEqual(rec)
      expect(got?.bytes).toEqual(bytes)
      // Missing id ⇒ null (not a throw), so the serve path can 404 cleanly.
      expect(await store.getBlobWithMetadata(ws, 'nope')).toBeNull()
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
      // countByBlock (the per-block upload-cap precheck) agrees with the list and scopes by block,
      // the same pairing `countByExecution` owes the run half. A count that disagreed with the list
      // would let the cap admit a row the reconcile then rolls back, or refuse one there is room
      // for — and only a cross-runtime assertion catches a WHERE clause that drifted on one of them.
      expect(await store.countByBlock(ws, blk)).toBe(byBlock.length)
      expect(await store.countByBlock(ws, 'blk_other')).toBe(0)
    })

    it('keys a render to its DOCUMENT and reclaims the whole set on re-import', async () => {
      // The design-render path: an import retains a source's frames keyed to the document itself
      // (no run, no block — neither exists yet), and the next import that changes the body replaces
      // them wholesale. Both halves have to agree across runtimes or a local import silently keeps
      // last month's frames beside this month's.
      const store = makeStore()
      const { ws, blk } = ids()
      const design = { source: 'figma' as const, externalId: 'file1:1-2' }
      const other = { source: 'figma' as const, externalId: 'file1:9-9' }
      const mk = (document: typeof design | null, view: string, n: number) =>
        store.store({
          meta: {
            workspaceId: ws,
            executionId: null,
            blockId: null,
            kind: 'reference',
            view,
            contentType: 'image/png',
            ...(document ? { document } : {}),
          },
          blob: png(n),
        })
      const first = await mk(design, 'Checkout', 1)
      const second = await mk(design, 'Confirm', 2)
      const sibling = await mk(other, 'Settings', 3)
      // A hand-uploaded reference against a block: same `kind`, no document, so the reclaim below
      // must leave it alone.
      const uploaded = await store.store({
        meta: {
          workspaceId: ws,
          executionId: null,
          blockId: blk,
          kind: 'reference',
          view: 'Checkout',
          contentType: 'image/png',
        },
        blob: png(4),
      })

      expect((await store.listByDocument(ws, design)).map((r) => r.id)).toEqual([
        first.id,
        second.id,
      ])
      expect((await store.getMetadata(ws, first.id))?.document).toEqual(design)
      expect((await store.getMetadata(ws, uploaded.id))?.document).toBeNull()

      // The batched read the visual-confirmation gate uses: the union of both documents' renders
      // in ONE call, ordered like the single-document read across the whole result (which is what
      // makes "the newest render for a view wins" hold however many designs a task links), with
      // the hand-uploaded reference (which names no document) left out.
      expect((await store.listByDocuments(ws, [design, other])).map((r) => r.id)).toEqual([
        first.id,
        second.id,
        sibling.id,
      ])
      // A repeated ref must not double the rows it matches, and an unknown one must not fail the
      // refs beside it.
      expect(
        (
          await store.listByDocuments(ws, [
            design,
            design,
            { source: 'figma' as const, externalId: 'nothing-imported' },
          ])
        ).map((r) => r.id),
      ).toEqual([first.id, second.id])
      expect(await store.listByDocuments(ws, [])).toEqual([])

      expect(await store.pruneByDocument(ws, design)).toBe(2)
      expect(await store.listByDocument(ws, design)).toEqual([])
      // Bytes go with the rows — a reclaim that left the blobs would leak them permanently.
      expect(await store.getBlob(ws, first.id)).toBeNull()
      // The other document's renders and the hand-uploaded reference are untouched.
      expect((await store.listByDocument(ws, other)).map((r) => r.id)).toEqual([sibling.id])
      expect(await store.getMetadata(ws, uploaded.id)).not.toBeNull()
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

    it('pruneOlderThan removes expired artifacts (metadata + bytes) and keeps fresh ones', async () => {
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
        blob: png(11),
      })
      // A cutoff in the past keeps the just-created artifact (createdAt ≮ cutoff).
      expect(await store.pruneOlderThan(ws, 1)).toBe(0)
      expect(await store.getMetadata(ws, rec.id)).not.toBeNull()
      // A cutoff in the future is past the artifact's createdAt, so it's pruned — and its
      // bytes go with it (no orphaned blob left behind).
      const removed = await store.pruneOlderThan(ws, Date.now() + 60_000)
      expect(removed).toBe(1)
      expect(await store.getMetadata(ws, rec.id)).toBeNull()
      expect(await store.getBlob(ws, rec.id)).toBeNull()
    })

    it('pruneOlderThan EXEMPTS a document’s renders, however old they are', async () => {
      // Age is the right lifetime for run debris and the wrong one for a document's renders. Those
      // are a projection of a live row: they are replaced by the next import that changes the body
      // and by nothing else, and an unedited design is never re-imported. Swept on a clock, the
      // document row would go on saying `stored` over an empty set with nothing to re-download
      // them — a silent loss, since no read fails and no status changes.
      const store = makeStore()
      const { ws, e1, blk } = ids()
      const design = { source: 'figma' as const, externalId: 'file1:1-2' }
      const debris = await store.store({
        meta: {
          workspaceId: ws,
          executionId: e1,
          blockId: blk,
          kind: 'screenshot',
          view: 'v',
          contentType: 'image/png',
        },
        blob: png(21),
      })
      const render = await store.store({
        meta: {
          workspaceId: ws,
          executionId: null,
          blockId: null,
          kind: 'reference',
          view: 'Checkout',
          contentType: 'image/png',
          document: design,
        },
        blob: png(22),
      })

      // A cutoff past BOTH rows: only the run's screenshot is old enough to be anybody's debris.
      expect(await store.pruneOlderThan(ws, Date.now() + 60_000)).toBe(1)
      expect(await store.getMetadata(ws, debris.id)).toBeNull()
      expect(await store.getMetadata(ws, render.id)).not.toBeNull()
      expect(await store.getBlob(ws, render.id)).not.toBeNull()
      // The document's own reclaim still takes it, which is the ONE thing that should.
      expect(await store.pruneByDocument(ws, design)).toBe(1)
      expect(await store.getBlob(ws, render.id)).toBeNull()
    })

    it('pruneOlderThan EXEMPTS a generated ASSET, however old it is', async () => {
      // The same argument as the document renders above, one axis over: the retention window is
      // sized for run DEBRIS, and an asset is the thing the run was started to produce. A swept
      // one takes its step's report with it, in the worst possible form: the report goes on
      // naming a location, so the loss reads as a broken link rather than as a reclaim.
      //
      // Asserted at the STORE, not at either facade's SQL, because that is where the two
      // implementations can differ: the predicate is a `NOT IN` on D1 and a `notInArray` on
      // Drizzle, and the list and the delete build it separately on both.
      const store = makeStore()
      const { ws, e1, blk } = ids()
      const debris = await store.store({
        meta: {
          workspaceId: ws,
          executionId: e1,
          blockId: blk,
          kind: 'screenshot',
          view: 'v',
          contentType: 'image/png',
        },
        blob: png(31),
      })
      const asset = await store.store({
        meta: {
          workspaceId: ws,
          executionId: e1,
          blockId: null,
          kind: 'asset',
          view: 'anvil sprite',
          contentType: 'image/png',
        },
        blob: png(32),
      })

      expect(await store.pruneOlderThan(ws, Date.now() + 60_000)).toBe(1)
      expect(await store.getMetadata(ws, debris.id)).toBeNull()
      expect(await store.getMetadata(ws, asset.id)).not.toBeNull()
      // The bytes survive too: a metadata row kept beside a reclaimed blob would be the same
      // broken link with an extra step.
      expect(await store.getBlob(ws, asset.id)).not.toBeNull()
      // It is still listed as the run's, which is what the report's read-back resolves against.
      expect((await store.listByExecution(ws, e1)).map((r) => r.id)).toEqual([asset.id])
    })

    it('deleteByWorkspace reclaims every artifact (rows + bytes) and scopes by workspace', async () => {
      // Drives the workspace-delete purge: on a board delete the retention sweep never sees the
      // (now-gone) workspace again, so every artifact — regardless of age, run or block — must be
      // reclaimed here, bytes included, without touching another workspace's artifacts.
      const store = makeStore()
      const { ws, e1, e2, blk } = ids()
      const mk = (workspaceId: string, executionId: string | null, n: number) =>
        store.store({
          meta: {
            workspaceId,
            executionId,
            blockId: blk,
            kind: 'screenshot',
            view: `v${n}`,
            contentType: 'image/png',
          },
          blob: png(n),
        })
      const a = await mk(ws, e1, 1)
      const b = await mk(ws, e2, 2)
      // A block-scoped reference upload (no executionId) must be reclaimed too.
      const ref = await mk(ws, null, 3)
      // A different workspace's artifact — must survive.
      const otherWs = `${ws}-other`
      const keep = await mk(otherWs, e1, 4)

      const removed = await store.deleteByWorkspace(ws)
      expect(removed).toBe(3)
      for (const rec of [a, b, ref]) {
        expect(await store.getMetadata(ws, rec.id)).toBeNull()
        expect(await store.getBlob(ws, rec.id)).toBeNull()
      }
      expect(await store.listByBlock(ws, blk)).toEqual([])
      // The other workspace is untouched (row + bytes).
      expect(await store.getMetadata(otherWs, keep.id)).not.toBeNull()
      expect(await store.getBlob(otherWs, keep.id)).toEqual(png(4))
    })
  })
}
