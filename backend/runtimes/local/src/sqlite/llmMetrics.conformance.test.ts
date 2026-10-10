import { defineLlmMetricsSuite } from '@cat-factory/conformance'
import { createLocalTelemetryStore } from './telemetryStore.js'

// The LLM call metric is the sink every other telemetry read aggregates over: the per-run spend
// rollup, the `(agentKind, phase)` fold and the operator ledger all start here. It has THREE
// stores, not two: D1 on Cloudflare, Postgres on Node, and this `node:sqlite` one on a
// mothership-mode laptop, where the ENGINE runs and so where a developer's own runs are recorded.
// Pinning it to the same suite the other two run is what keeps a carry-cost ordering fix or an
// idempotency rule from landing in two of the three.
//
// One in-memory store for the whole suite: every case scopes itself to freshly generated ids.
const store = createLocalTelemetryStore(':memory:')

defineLlmMetricsSuite('local-sqlite', () => store.llmCallMetricRepository)
