import { defineKaizenSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1KaizenGradingRepository } from '../../src/infrastructure/repositories/D1KaizenGradingRepository'
import { D1KaizenVerifiedComboRepository } from '../../src/infrastructure/repositories/D1KaizenVerifiedComboRepository'

// Cross-runtime parity for the Kaizen persistence against the Worker's real D1
// repositories (the main DB), inside workerd. The Node service runs the identical suite
// over Postgres — together they mandate the two stores behave the same.
defineKaizenSuite(
  'cloudflare',
  () => new D1KaizenGradingRepository({ db: env.DB }),
  () => new D1KaizenVerifiedComboRepository({ db: env.DB }),
)
