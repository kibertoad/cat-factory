import { defineSubscriptionActivationSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1SubscriptionActivationRepository } from '../../src/infrastructure/repositories/D1PersonalSubscriptionRepository'
import { D1UserRepository } from '../../src/infrastructure/repositories/D1UserRepository'

// Cross-runtime parity for the per-run subscription-activation store against the Worker's
// real D1 repository, inside workerd. The Node service runs the identical suite over its own
// Postgres table — together they mandate the two stores behave the same. The suite seeds the
// referenced user (a Postgres FK; D1 doesn't enforce it) through the UserRepository.
defineSubscriptionActivationSuite('cloudflare', () => ({
  activations: new D1SubscriptionActivationRepository({ db: env.DB }),
  users: new D1UserRepository({ db: env.DB }),
}))
