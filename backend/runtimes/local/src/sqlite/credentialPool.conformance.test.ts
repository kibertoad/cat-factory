import { defineCredentialPoolSuite } from '@cat-factory/conformance'
import { createLocalCredentialStore } from './credentialStore.js'

// Cross-store parity for the enable/disable + pinned-default credential-pool behaviour against
// the mothership-mode LOCAL `node:sqlite` credential store — the third implementation of the
// pool repositories alongside D1 (Worker) and Drizzle/Postgres (Node). Ids are unique per case
// so the shared in-memory db stays isolated, matching the D1/Postgres conformance runs.
const store = createLocalCredentialStore(':memory:')

defineCredentialPoolSuite('local-sqlite', {
  makeApiKeyRepo: () => store.providerApiKeyRepository,
  makeSubscriptionRepo: () => store.providerSubscriptionTokenRepository,
})
