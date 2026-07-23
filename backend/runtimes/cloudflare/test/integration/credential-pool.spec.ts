import { defineCredentialPoolSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1ProviderApiKeyRepository } from '../../src/infrastructure/repositories/D1ProviderApiKeyRepository'
import { D1ProviderSubscriptionTokenRepository } from '../../src/infrastructure/repositories/D1ProviderSubscriptionTokenRepository'

// Cross-runtime parity for the credential pools' enable/disable + pinned-default behaviour
// against the Worker's real D1 repositories, inside workerd. The Node service runs the
// identical suite over Postgres — together they mandate the `enabled`/`is_default` filter +
// lease ordering matches across stores.
defineCredentialPoolSuite('cloudflare', {
  makeApiKeyRepo: () => new D1ProviderApiKeyRepository({ db: env.DB }),
  makeSubscriptionRepo: () => new D1ProviderSubscriptionTokenRepository({ db: env.DB }),
})
