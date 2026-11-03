import { defineWritebackPostSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1WritebackPostRepository } from '../../src/infrastructure/repositories/D1WritebackPostRepository'

// Cross-runtime parity for the writeback exactly-once markers against the Worker's real D1
// repository inside workerd. The Node facade runs the identical suite over Postgres.
defineWritebackPostSuite('cloudflare', () => new D1WritebackPostRepository({ db: env.DB }))
