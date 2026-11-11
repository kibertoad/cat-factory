import {
  type ProjectDefinitionRegistry,
  defaultProjectDefinitionRegistry,
} from '@cat-factory/kernel'

/** The research definition key the e2e research specs pin. */
export const E2E_RESEARCH_DEFINITION_KEY = 'e2e:vendor'

/**
 * The research definitions the e2e backend registers in code: one vendor definition with two
 * questions and a credential the agent asks for when it needs it, so a spec can pin a research
 * project, run a task and read the findings back. The fake agent answers every question it is
 * handed.
 */
export function e2eResearchDefinitions(): ProjectDefinitionRegistry {
  const registry = defaultProjectDefinitionRegistry()
  registry.register({
    kind: 'research',
    key: E2E_RESEARCH_DEFINITION_KEY,
    version: 1,
    title: 'Vendor integration',
    spec: {
      brief: 'Learn how the vendor authenticates and what its API exposes.',
      topics: [
        {
          id: 'auth',
          title: 'Authentication',
          questions: [
            { id: 'scheme', question: 'Which authentication scheme does the API use?' },
            { id: 'scopes', question: 'Which scopes does an integration need?' },
          ],
        },
      ],
    },
    credentials: [
      {
        key: 'E2E_VENDOR_LOGIN',
        kind: 'login',
        label: 'Vendor admin login',
        onboarding: { instructions: 'Create a user with the Integrator role.' },
        requiredAtStart: false,
      },
    ],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  })
  return registry
}
