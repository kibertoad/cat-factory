import { defineAgentPromptSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AgentPromptRepository } from '../../src/infrastructure/repositories/D1AgentPromptRepository'

// Cross-runtime parity for the agent system-prompt override log against the Worker's real D1
// repository, inside workerd. The Node service runs the identical suite over Postgres — together
// they mandate the two stores agree on the nullable `text` (the "back to the built-in" revision),
// on resolving the head by highest revision, and on REFUSING a duplicate revision rather than
// overwriting it.
defineAgentPromptSuite('cloudflare', () => new D1AgentPromptRepository({ db: env.DB }))
