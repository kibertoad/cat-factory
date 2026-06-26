import { defineAgentContextSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AgentContextSnapshotRepository } from '../../src/infrastructure/repositories/D1AgentContextSnapshotRepository'

// Cross-runtime parity for the agent-context observability sink against the Worker's
// real D1 repository in the dedicated TELEMETRY_DB database, inside workerd. The Node
// service runs the identical suite over Postgres (the `telemetry` schema) — together
// they mandate the two stores behave the same.
defineAgentContextSuite(
  'cloudflare',
  () => new D1AgentContextSnapshotRepository({ db: env.TELEMETRY_DB }),
)
