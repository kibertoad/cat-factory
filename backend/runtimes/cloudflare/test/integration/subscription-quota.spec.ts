import { defineSubscriptionQuotaSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1SubscriptionQuotaCycleRepository } from '../../src/infrastructure/repositories/D1SubscriptionQuotaCycleRepository'

// Cross-runtime parity for the subscription quota-cycle store against the Worker's real D1
// repository, inside workerd. The Node service runs the identical suite over Postgres —
// together they mandate the two stores' windowed-UPSERT/reset behaviour matches.
defineSubscriptionQuotaSuite(
  'cloudflare',
  () => new D1SubscriptionQuotaCycleRepository({ db: env.DB }),
)
