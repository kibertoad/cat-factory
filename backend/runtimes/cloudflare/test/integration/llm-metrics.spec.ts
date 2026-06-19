import { defineLlmMetricsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1LlmCallMetricRepository } from '../../src/infrastructure/repositories/D1LlmCallMetricRepository'

// Cross-runtime parity for the LLM observability sink against the Worker's real D1
// repository (migration 0026), inside workerd. The Node service runs the identical
// suite over Postgres — together they mandate the two stores behave the same.
defineLlmMetricsSuite('cloudflare', () => new D1LlmCallMetricRepository({ db: env.DB }))
