import { type ConformanceHarness, defineExecutionConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeMothershipConformanceApp, setupMothershipDb } from './harness.js'

// Execution-engine slice of the shared conformance suite against the MOTHERSHIP-MODE config:
// a no-Postgres node whose repositories are RPC-backed by a real in-process Node mothership.
// Running the SAME assertions here proves every org/durable repository method the run lifecycle
// touches is correctly proxied (allow-listed + scoped + serialized) — an un-proxied one fails
// THIS test with `unknown_method`. See ./harness.ts for the topology.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupMothershipDb()
  const harness: ConformanceHarness = {
    name: 'mothership',
    makeApp: (agentOptions, opts) => makeMothershipConformanceApp(db, agentOptions, opts),
  }
  defineExecutionConformance(harness)
} else {
  describe.skip('[mothership] conformance execution (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
