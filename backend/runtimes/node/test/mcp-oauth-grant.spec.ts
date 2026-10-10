import { defineMcpOAuthGrantSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the per-workspace MCP OAuth grant store against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over D1, so the two
// stores cannot drift about the composite key or the refresh path's rev guard. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineMcpOAuthGrantSuite(
    'node',
    () => createDrizzleRepositories(db, clock).mcpOAuthGrantRepository,
  )
} else {
  describe.skip('[node] mcp oauth grants (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
