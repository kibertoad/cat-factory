import { type ConformanceHarness, defineProjectsSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeMothershipConformanceApp, setupMothershipDb } from './harness.js'

// Projects and research against the MOTHERSHIP-MODE config: every project, mount, research and
// link repository method these flows reach must be allow-listed and scoped on the persistence
// RPC, or this fails with `unknown_method` or a scope refusal. See ./harness.ts for the topology.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupMothershipDb()
  const harness: ConformanceHarness = {
    name: 'mothership',
    makeApp: (agentOptions, opts) => makeMothershipConformanceApp(db, agentOptions, opts),
  }
  defineProjectsSuite(harness)
} else {
  describe.skip('[mothership] conformance projects (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
