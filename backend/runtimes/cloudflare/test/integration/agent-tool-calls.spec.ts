import { defineAgentToolCallSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AgentToolCallRepository } from '../../src/infrastructure/repositories/D1AgentToolCallRepository'

// Cross-runtime parity for the tool-call trajectory sink against the Worker's real D1 repository
// in the dedicated TELEMETRY_DB database, inside workerd. The Node service runs the identical
// suite over Postgres (the `telemetry` schema) — together they mandate the two stores behave the
// same.
defineAgentToolCallSuite(
  'cloudflare',
  () => new D1AgentToolCallRepository({ db: env.TELEMETRY_DB }),
)
