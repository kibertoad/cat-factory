import { defineUserRepoAccessSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1UserRepoAccessRepository } from '../../src/infrastructure/repositories/D1UserRepoAccessRepository'

// The Worker's real D1 user-repo-access repo, run through the shared cross-runtime parity suite
// inside workerd (the Node service runs the identical suite over its Drizzle/Postgres repo), so a
// column/`IN`-read divergence fails a test instead of shipping.
defineUserRepoAccessSuite('cloudflare', () => new D1UserRepoAccessRepository({ db: env.DB }))
