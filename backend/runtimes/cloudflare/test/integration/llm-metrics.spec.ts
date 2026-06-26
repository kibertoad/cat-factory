import { defineLlmMetricsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1LlmCallMetricRepository } from '../../src/infrastructure/repositories/D1LlmCallMetricRepository'

// Cross-runtime parity for the LLM observability sink against the Worker's real D1
// repository in the dedicated TELEMETRY_DB database, inside workerd. The Node service
// runs the identical suite over Postgres (the `telemetry` schema) — together they
// mandate the two stores behave the same.
defineLlmMetricsSuite('cloudflare', () => new D1LlmCallMetricRepository({ db: env.TELEMETRY_DB }))
