import { defineEnvironmentHandlersSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1CustomManifestTypeRepository } from '../../src/infrastructure/repositories/D1CustomManifestTypeRepository'
import { D1EnvironmentUserHandlerRepository } from '../../src/infrastructure/repositories/D1EnvironmentUserHandlerRepository'

// Cross-runtime parity for the per-service provision-type persistence against the Worker's
// real D1 repositories (the main DB binding), inside workerd. The Node service runs the
// identical suite over Postgres — together they mandate the two stores behave the same.
defineEnvironmentHandlersSuite('cloudflare', () => ({
  userHandlers: new D1EnvironmentUserHandlerRepository({ db: env.DB }),
  customTypes: new D1CustomManifestTypeRepository({ db: env.DB }),
}))
