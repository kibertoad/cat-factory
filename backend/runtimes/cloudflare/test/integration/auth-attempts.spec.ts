import { defineAuthAttemptSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AuthAttemptRepository } from '../../src/infrastructure/repositories/D1AuthAttemptRepository'
import { CryptoIdGenerator } from '../../src/infrastructure/runtime'

// Cross-runtime parity for the durable auth-attempt ledger (SEC-4) against the Worker's
// real D1 repository, inside workerd. The Node service runs the identical suite over its
// own Postgres table — together they mandate the two stores behave the same.
defineAuthAttemptSuite(
  'cloudflare',
  () => new D1AuthAttemptRepository({ db: env.DB, idGenerator: new CryptoIdGenerator() }),
)
