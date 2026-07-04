import { defineInitiativeSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1BlockRepository } from '../../src/infrastructure/repositories/D1BlockRepository'
import { D1InitiativeRepository } from '../../src/infrastructure/repositories/D1InitiativeRepository'

// Cross-runtime parity for the initiative store against the Worker's real D1
// repositories, inside workerd. The Node service runs the identical suite over
// Postgres — together they mandate the two stores behave the same (the doc-blob
// round-trip, the rev-guarded CAS, and the blocks.initiative_id membership column).
defineInitiativeSuite('cloudflare', () => ({
  initiatives: new D1InitiativeRepository({ db: env.DB }),
  blocks: new D1BlockRepository({ db: env.DB }),
}))
