import { defineTokenUsageSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1TokenUsageRepository } from '../../src/infrastructure/repositories/D1TokenUsageRepository'

// Cross-runtime parity for the token-usage ledger against the Worker's real D1 repository,
// inside workerd. The Node service runs the identical suite over its own Postgres table —
// together they mandate the two stores behave the same.
defineTokenUsageSuite('cloudflare', () => new D1TokenUsageRepository({ db: env.DB }))
