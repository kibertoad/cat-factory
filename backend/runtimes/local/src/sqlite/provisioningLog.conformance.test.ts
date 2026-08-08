import { defineProvisioningLogSuite } from '@cat-factory/conformance'
import { createLocalTelemetryStore } from './telemetryStore.js'

// The provisioning log is append-heavy and read back per environment, and its rows are what an
// operator reads when a teardown claims to have reclaimed something. Same three-store argument as
// its telemetry siblings.
//
// One in-memory store for the whole suite: every case scopes itself to freshly generated ids.
const store = createLocalTelemetryStore(':memory:')

defineProvisioningLogSuite('local-sqlite', () => store.provisioningLogRepository)
