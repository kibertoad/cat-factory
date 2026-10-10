import { defineSharedStackSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1SharedStackRepository } from '../../src/infrastructure/repositories/D1SharedStackRepository'

// Cross-runtime parity for the shared-stack store against the Worker's real D1 repository,
// inside workerd. The Node service runs the identical suite over Postgres — together they
// mandate the two stores behave the same (the JSON columns + the allow_host_commands boolean).
defineSharedStackSuite('cloudflare', () => new D1SharedStackRepository({ db: env.DB }))
