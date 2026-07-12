import { defineScheduleRunSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1PipelineScheduleRepository } from '../../src/infrastructure/repositories/D1PipelineScheduleRepository'

// Cross-runtime parity for the recurring-pipeline run history against the Worker's real D1
// repository, inside workerd. The Node service runs the identical suite over its own
// Postgres table — together they mandate the two stores behave the same.
defineScheduleRunSuite('cloudflare', () => new D1PipelineScheduleRepository({ db: env.DB }))
