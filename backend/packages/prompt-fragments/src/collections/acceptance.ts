import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragments for the acceptance-testing track: writing acceptance
// scenarios from requirements, and turning them into runnable tests. The
// runnable-tests step uses Playwright for user-facing blocks and the project's
// own test framework for backend blocks, so there is one fragment per surface,
// scoped by block type. Selected per block, these bodies are injected verbatim
// into the acceptance / playwright agents' system prompts.

export const acceptanceFragments: PromptFragment[] = [
  {
    id: 'acceptance.scenarios',
    version: '1.0.0',
    title: 'Acceptance scenarios',
    category: 'Acceptance testing',
    summary: 'Given/When/Then scenarios tied to requirements, asserting observable behaviour.',
    body: [
      'Acceptance scenario standards:',
      '- Trace every scenario back to a stated requirement; do not test behaviour nobody asked for.',
      '- Write each scenario as a titled Given / When / Then with a single clear When and concrete, observable Then assertions.',
      '- Cover the happy path, the meaningful alternative flows, error handling and boundary conditions — in that order of priority.',
      '- Keep scenarios independent and deterministic: each sets up its own state and asserts user-visible outcomes, never internals.',
      '- Call out any requirement that is ambiguous or untestable instead of guessing at the intended behaviour.',
    ].join('\n'),
    appliesTo: { agentKinds: ['acceptance'] },
  },
  {
    id: 'playwright.e2e',
    version: '1.0.0',
    title: 'Playwright end-to-end tests',
    category: 'Acceptance testing',
    summary: 'User-facing locators, web-first assertions, isolated and idempotent test files.',
    body: [
      'Playwright end-to-end test standards:',
      '- Map one `test` to one acceptance scenario and name it after the scenario so coverage is traceable.',
      '- Be additive: only add tests for scenarios that lack one; never duplicate or silently rewrite an existing test.',
      '- Select elements by user-facing locators (getByRole, getByLabel, getByText), not brittle CSS or XPath.',
      '- Rely on web-first auto-retrying assertions (expect(locator)…) and await every action; never use fixed sleeps.',
      '- Keep each test isolated and deterministic — fresh state per test, no ordering dependencies between tests.',
      '- Target the environment URL from the run context and read credentials from the harness; never hard-code secrets or hosts.',
    ].join('\n'),
    appliesTo: { blockTypes: ['frontend', 'environment'], agentKinds: ['playwright'] },
  },
  {
    id: 'acceptance.backend-tests',
    version: '1.0.0',
    title: 'Backend acceptance tests',
    category: 'Acceptance testing',
    summary:
      "Acceptance tests in the project's own framework, driven through public backend interfaces.",
    body: [
      'Backend acceptance test standards:',
      "- Write the tests with the project's existing test framework — discover it from the repo (test config, dev dependencies, the tests already present); do not introduce a new framework, and do not use Playwright or a browser for behaviour with no UI.",
      '- Map one test to one acceptance scenario and name it after the scenario so coverage is traceable.',
      '- Be additive: only add tests for scenarios that lack one; never duplicate or silently rewrite an existing test.',
      '- Drive the system through its outermost public interface (HTTP/API calls, queue messages, exported functions) and assert on observable behaviour, never on internals.',
      '- Keep each test isolated and deterministic — fresh state per test, no ordering dependencies; await async work instead of fixed sleeps.',
      '- Target the system at the URL / entry point from the run context and read credentials from the harness; never hard-code secrets or hosts.',
    ].join('\n'),
    appliesTo: {
      blockTypes: ['service', 'api', 'database', 'queue', 'integration', 'external'],
      agentKinds: ['playwright'],
    },
  },
]
