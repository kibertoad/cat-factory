import { defineRefinedRequirementsPostSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1RefinedRequirementsPostRepository } from '../../src/infrastructure/repositories/D1RefinedRequirementsPostRepository'

// Cross-runtime parity for the refined-requirements post markers against the Worker's real D1
// repository inside workerd. The Node facade runs the identical suite over Postgres.
defineRefinedRequirementsPostSuite(
  'cloudflare',
  () => new D1RefinedRequirementsPostRepository({ db: env.DB }),
)
