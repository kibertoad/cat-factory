import { defineCommitProjectionSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1CommitProjectionRepository } from '../../src/infrastructure/repositories/D1CommitProjectionRepository'

// Cross-runtime parity for the github_commits projection against the Worker's real D1
// repository, inside workerd. The Node service runs the identical suite over its own
// Postgres table — together they mandate the two stores behave the same.
defineCommitProjectionSuite('cloudflare', () => new D1CommitProjectionRepository({ db: env.DB }))
