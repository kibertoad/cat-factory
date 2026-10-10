import { defineAgentSearchQuerySuite } from '@cat-factory/conformance'
import { createLocalTelemetryStore } from './telemetryStore.js'

// Agent search queries record what an agent looked for, which is only useful as a per-run
// ordered read. Held to the same suite as the D1 and Postgres stores so the local one cannot
// drift on ordering or scoping.
//
// One in-memory store for the whole suite: every case scopes itself to freshly generated ids.
const store = createLocalTelemetryStore(':memory:')

defineAgentSearchQuerySuite('local-sqlite', () => store.agentSearchQueryRepository)
