import { defineEnvironmentTestSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1EnvironmentTestRunRepository } from '../../src/infrastructure/repositories/D1EnvironmentTestRunRepository'

// Cross-runtime parity for the ephemeral-environment self-test run store against the Worker's
// real D1 repository inside workerd. The Node service runs the identical suite over its own
// Postgres, so the two stores can't drift.
defineEnvironmentTestSuite('cloudflare', () => new D1EnvironmentTestRunRepository({ db: env.DB }))
