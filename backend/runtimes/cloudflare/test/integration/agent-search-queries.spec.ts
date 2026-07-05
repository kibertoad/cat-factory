import { defineAgentSearchQuerySuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AgentSearchQueryRepository } from '../../src/infrastructure/repositories/D1AgentSearchQueryRepository'

// Cross-runtime parity for the agent-search-query observability sink against the Worker's
// real D1 repository in the dedicated TELEMETRY_DB database, inside workerd. The Node
// service runs the identical suite over Postgres (the `telemetry` schema) — together
// they mandate the two stores behave the same.
defineAgentSearchQuerySuite(
  'cloudflare',
  () => new D1AgentSearchQueryRepository({ db: env.TELEMETRY_DB }),
)
