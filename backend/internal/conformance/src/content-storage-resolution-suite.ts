import type { BinaryArtifactMetadataStore, Clock, IdGenerator } from '@cat-factory/kernel'
import {
  type BuildBlobBackend,
  type ContentStorageSettingsResolver,
  makeResolveBinaryArtifactStore,
} from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { MemoryBinaryBlobBackend } from './binary-artifacts-suite.js'

type BackendKind = 'off' | 'fs' | 's3' | 'r2' | 'db'

// Cross-runtime parity for the PER-ACCOUNT binary-artifact store resolver
// (`makeResolveBinaryArtifactStore`). The resolver itself is runtime-neutral shared code, but
// it composes the runtime's REAL metadata store (D1 ⇄ Drizzle) with the account-selected blob
// backend — so this suite drives the resolver against each runtime's real metadata store and
// asserts the resolved store round-trips, that the account-configured backend overrides the
// runtime default, and that `off` / a backend the runtime can't serve resolve to null. A
// facade whose metadata store maps a column differently fails here instead of shipping.

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])

export interface ContentStorageResolutionHarness {
  /** The runtime's REAL binary-artifact metadata store (D1 on Cloudflare, Drizzle on Node). */
  metadata: BinaryArtifactMetadataStore
  idGenerator: IdGenerator
  clock: Clock
}

export function defineContentStorageResolutionSuite(
  name: string,
  harness: ContentStorageResolutionHarness,
): void {
  describe(`[${name}] per-account binary-artifact store resolution`, () => {
    let seq = 0
    const tag = () => `${name}-cs-${++seq}-${Math.floor(Math.random() * 1e9)}`

    // A blob factory that serves fs/s3/r2 with the in-memory backend but NOT `db`, so a `db`
    // selection exercises the "runtime can't serve this kind ⇒ null" path. The metadata store
    // is always the runtime's real one — only the bytes live in memory for the test.
    const buildBlobBackend: BuildBlobBackend = (kind) =>
      kind === 'fs' || kind === 's3' || kind === 'r2' ? new MemoryBinaryBlobBackend() : null

    // A mutable account-settings stub so a test can set an account's configured backend.
    const configByAccount = new Map<string, { backend: BackendKind }>()
    const accountSettings: ContentStorageSettingsResolver = {
      resolve: (accountId: string) =>
        Promise.resolve({ config: { contentStorage: configByAccount.get(accountId) } }),
    }

    const makeResolve = (defaultBackend: BackendKind) =>
      makeResolveBinaryArtifactStore({
        accountSettings,
        accountOf: (workspaceId) => Promise.resolve(`acc-${workspaceId}`),
        metadata: harness.metadata,
        idGenerator: harness.idGenerator,
        clock: harness.clock,
        buildBlobBackend,
        defaultBackend,
      })

    it('resolves the runtime default and round-trips against the real metadata store', async () => {
      const ws = `ws-${tag()}`
      const resolve = makeResolve('fs')
      const store = await resolve(ws)
      if (!store) throw new Error('expected a resolved store for the runtime default')
      const bytes = png(1)
      const executionId = `e-${tag()}`
      const rec = await store.store({
        meta: {
          workspaceId: ws,
          executionId,
          blockId: `blk-${tag()}`,
          kind: 'screenshot',
          view: 'login',
          contentType: 'image/png',
        },
        blob: bytes,
      })
      expect(rec.id).toBeTruthy()
      expect(await store.getBlob(ws, rec.id)).toEqual(bytes)
      expect((await store.listByExecution(ws, executionId)).map((r) => r.id)).toEqual([rec.id])
    })

    it('uses the account-configured backend over the runtime default (round-trips too)', async () => {
      const ws = `ws-${tag()}`
      configByAccount.set(`acc-${ws}`, { backend: 's3' })
      const resolve = makeResolve('off') // default would yield null; the account override wins
      const store = await resolve(ws)
      if (!store) throw new Error('expected the account-configured backend to resolve a store')
      const bytes = png(2)
      const rec = await store.store({
        meta: {
          workspaceId: ws,
          executionId: null,
          blockId: `blk-${tag()}`,
          kind: 'reference',
          view: 'dashboard',
          contentType: 'image/png',
        },
        blob: bytes,
      })
      expect(await store.getBlob(ws, rec.id)).toEqual(bytes)
    })

    it('resolves to null when the effective backend is off', async () => {
      const ws = `ws-${tag()}`
      configByAccount.set(`acc-${ws}`, { backend: 'off' })
      expect(await makeResolve('fs')(ws)).toBeNull()
    })

    it('resolves to null when the runtime cannot serve the configured backend', async () => {
      const ws = `ws-${tag()}`
      configByAccount.set(`acc-${ws}`, { backend: 'db' }) // not served by this factory
      expect(await makeResolve('fs')(ws)).toBeNull()
    })
  })
}
