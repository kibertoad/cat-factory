import {
  defineBinaryArtifactsSuite,
  defineContentStorageResolutionSuite,
  MemoryBinaryBlobBackend,
} from '@cat-factory/conformance'
import { createBinaryArtifactStore } from '@cat-factory/kernel'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the binary-artifact storage abstraction against the Node
// facade's real Drizzle/Postgres metadata store, with an in-memory blob backend. The
// Cloudflare Worker runs the identical suite over D1, so the two stores can't drift.
// CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  let counter = 0
  const idGenerator = { next: (prefix?: string) => `${prefix ?? 'id'}-${++counter}` }
  defineBinaryArtifactsSuite('node', () =>
    createBinaryArtifactStore({
      metadata: createDrizzleRepositories(db, clock).binaryArtifactMetadataStore,
      blob: new MemoryBinaryBlobBackend(),
      idGenerator,
      clock,
    }),
  )
  // Per-account store resolution against the same real Postgres metadata store.
  defineContentStorageResolutionSuite('node', {
    metadata: createDrizzleRepositories(db, clock).binaryArtifactMetadataStore,
    idGenerator,
    clock,
  })
} else {
  describe.skip('[node] binary artifacts (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
