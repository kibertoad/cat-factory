import { defineAgentToolCallSuite } from '@cat-factory/conformance'
import { createLocalTelemetryStore } from './telemetryStore.js'

// The tool-call trajectory sink has THREE stores, not two: D1 on Cloudflare, Postgres on Node, and
// this `node:sqlite` one on a mothership-mode laptop, which is local-first precisely because the
// capture sits on a run's hot path. So it is held to the same suite the other two are — otherwise
// the store a developer's own runs are recorded in is the one nothing pins, and the drift would
// surface as a trajectory that reads correctly in the hosted product and out of order on a laptop.
//
// One in-memory store for the whole suite: every case scopes itself to freshly generated ids.
const store = createLocalTelemetryStore(':memory:')

defineAgentToolCallSuite('local-sqlite', () => store.agentToolCallRepository)
