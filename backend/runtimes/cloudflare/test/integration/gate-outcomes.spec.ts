import { type GateOutcomeSeed, defineGateOutcomeSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1GateOutcomeRepository } from '../../src/infrastructure/repositories/D1GateOutcomeRepository'

// Cross-runtime parity for the settled-gate projection against the Worker's real D1 store
// inside workerd. The Node service runs the identical suite over Postgres, so the two
// dialects' conflict handling and conditional aggregation can't drift.

const seed: GateOutcomeSeed = {
  async workspace(id, accountId) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO workspaces (id, name, created_at, account_id) VALUES (?, ?, ?, ?)',
    )
      .bind(id, id, 0, accountId)
      .run()
  },
}

defineGateOutcomeSuite(
  'cloudflare',
  () => new D1GateOutcomeRepository({ db: env.DB }),
  () => seed,
)
