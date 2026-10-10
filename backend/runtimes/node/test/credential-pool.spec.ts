import { defineCredentialPoolSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleProviderApiKeyRepository } from '../src/repositories/providerApiKey.js'
import { DrizzleProviderSubscriptionTokenRepository } from '../src/repositories/providerSubscription.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the credential pools' enable/disable + pinned-default behaviour
// against the Node facade's real Drizzle/Postgres repositories. The Cloudflare Worker runs
// the identical suite over D1, so the two stores can't drift. CI provides Postgres via
// `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineCredentialPoolSuite('node', {
    makeApiKeyRepo: () => new DrizzleProviderApiKeyRepository(db),
    makeSubscriptionRepo: () => new DrizzleProviderSubscriptionTokenRepository(db),
  })
} else {
  describe.skip('[node] credential pools (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
