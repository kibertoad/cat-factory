import { defineAccountRunnerPoolSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AccountRepository } from '../../src/infrastructure/repositories/D1AccountRepository'
import { D1AccountRunnerPoolRepository } from '../../src/infrastructure/repositories/D1AccountRunnerPoolRepository'

// Cross-runtime parity for the account tier of the runner pool against the Worker's real D1
// repositories inside workerd. The Node service runs the identical suite over Postgres.
defineAccountRunnerPoolSuite('cloudflare', () => ({
  pools: new D1AccountRunnerPoolRepository({ db: env.DB }),
  accounts: new D1AccountRepository({ db: env.DB }),
}))
