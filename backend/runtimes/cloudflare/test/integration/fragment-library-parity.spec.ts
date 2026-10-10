import { defineFragmentLibrarySuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1FragmentSourceRepository } from '../../src/infrastructure/repositories/D1FragmentSourceRepository'
import { D1PromptFragmentRepository } from '../../src/infrastructure/repositories/D1PromptFragmentRepository'

// Cross-runtime parity for the repo-sourced prompt-fragment library against the Worker's real D1
// repositories, inside workerd. The Node service runs the identical suite over its own Postgres
// tables — together they mandate the two stores behave the same.
defineFragmentLibrarySuite('cloudflare', () => ({
  sources: new D1FragmentSourceRepository({ db: env.DB }),
  fragments: new D1PromptFragmentRepository({ db: env.DB }),
}))
