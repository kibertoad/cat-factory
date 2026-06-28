import { defineBinaryArtifactsSuite, MemoryBinaryBlobBackend } from '@cat-factory/conformance'
import { createBinaryArtifactStore } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { D1BinaryArtifactMetadataStore } from '../../src/infrastructure/repositories/D1BinaryArtifactMetadataStore'

// Cross-runtime parity for the binary-artifact storage abstraction against the Worker's
// real D1 metadata store (main DB), with an in-memory blob backend. The Node service runs
// the identical suite over Postgres, so the two metadata stores can't drift.
let counter = 0
const idGenerator = { next: (prefix?: string) => `${prefix ?? 'id'}-${++counter}` }
const clock = { now: () => Date.now() }

defineBinaryArtifactsSuite('cloudflare', () =>
  createBinaryArtifactStore({
    metadata: new D1BinaryArtifactMetadataStore({ db: env.DB }),
    blob: new MemoryBinaryBlobBackend(),
    idGenerator,
    clock,
  }),
)
