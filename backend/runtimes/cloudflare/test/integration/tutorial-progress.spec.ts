import { defineTutorialProgressSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1TutorialProgressRepository } from '../../src/infrastructure/repositories/D1TutorialProgressRepository'

// Cross-runtime parity for the per-user tutorial-progress store against the Worker's real D1
// repository, inside workerd. The Node facade runs the identical suite over its own Postgres table —
// together they mandate the two stores map the row, and above all the two JSON id lists, the same.
defineTutorialProgressSuite('cloudflare', () => new D1TutorialProgressRepository({ db: env.DB }))
