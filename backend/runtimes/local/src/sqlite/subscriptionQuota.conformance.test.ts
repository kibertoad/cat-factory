import { defineSubscriptionQuotaSuite } from '@cat-factory/conformance'
import { createLocalTelemetryStore } from './telemetryStore.js'

// Subscription quota cycles gate whether a run may spend at all, so a local store that scoped or
// rolled a cycle differently would let a laptop run past a ceiling the hosted product enforces.
// Same three-store argument as its telemetry siblings.
//
// One in-memory store for the whole suite: every case scopes itself to freshly generated ids.
const store = createLocalTelemetryStore(':memory:')

defineSubscriptionQuotaSuite('local-sqlite', () => store.subscriptionQuotaCycleRepository)
