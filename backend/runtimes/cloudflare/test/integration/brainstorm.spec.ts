import { defineBrainstormSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1BrainstormSessionRepository } from '../../src/infrastructure/repositories/D1BrainstormSessionRepository'

// Cross-runtime parity for the brainstorm (structured-dialogue) session store against the
// Worker's real D1 repository, inside workerd. The Node service runs the identical suite over
// Postgres — together they mandate the two stores behave the same (including the per-stage
// keying that lets one block hold both a requirements and an architecture session).
defineBrainstormSuite('cloudflare', () => new D1BrainstormSessionRepository({ db: env.DB }))
