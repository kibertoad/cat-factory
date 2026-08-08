import { defineAgentContextSuite } from '@cat-factory/conformance'
import { createLocalTelemetryStore } from './telemetryStore.js'

// Agent context snapshots are the double-gated prompt/response bodies, so a divergence here is
// invisible until someone opens a run in the debugger and finds the wrong body, or none. Same
// three-store argument as the metrics sibling: the mothership-mode laptop store is the one
// nothing pinned.
//
// One in-memory store for the whole suite: every case scopes itself to freshly generated ids.
const store = createLocalTelemetryStore(':memory:')

defineAgentContextSuite('local-sqlite', () => store.agentContextSnapshotRepository)
