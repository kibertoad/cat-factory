import type { AgentKind, BlockType } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import { PLATFORM_DELIVERY_CONTRACT } from './ci-gate.js'
import { PLAYWRIGHT_E2E_TARGET_CONFIG_ID } from './agent-configs.js'
import { STANDARDS_FOOTER } from './prompt-shared.js'

/** The acceptance/e2e execution targets the `playwright.e2eTarget` config offers. */
type E2eTarget = 'ci' | 'ephemeral'

// Built-out role prompt for the acceptance-test authoring agent. The structured
// acceptance SCENARIOS now live in the service spec (`spec.json`, authored by the
// `spec-writer` and reviewed there) and are rendered deterministically into Gherkin
// `spec/features/*.feature` files. The single remaining agent here:
//
//   - `playwright` reads those derived Gherkin scenarios and emits runnable
//     acceptance TESTS, committed to the repository, adding only tests that do not
//     exist yet. It reaches for Playwright only when the block has a user-facing UI;
//     for backend behaviour it writes the tests with the project's own test
//     framework, which `testApproachSection` selects from the block type.
//
// Like the standard solution phases, "what the agent should do" lives here and
// "which extra standards apply" stays in @cat-factory/prompt-fragments: the prompt
// closes by deferring to the best-practice fragments that `composeSystemPrompt`
// appends below it.

/** The agent kinds that make up the acceptance-testing track. */
export type AcceptanceAgentKind = 'playwright'

export const ACCEPTANCE_AGENT_KINDS: readonly AcceptanceAgentKind[] = ['playwright']

// The runnable-tests step commits tests through a pull request. Tests only earn
// their keep once they actually run in CI, so "done" means the suite is wired into
// the project's CI configuration AND passes locally. The agent does NOT push or wait
// on CI itself (it has no push credentials) — the platform pushes, opens the PR and
// drives CI per the shared PLATFORM_DELIVERY_CONTRACT; the agent's job is to author
// the tests and hook them into the CI config.
const PLAYWRIGHT_DELIVERY_GATE = [
  'Definition of done: the acceptance tests are written, wired into the project CI configuration, and pass when you run them locally.',
  '- Make sure the suite is actually hooked into the project CI workflow: confirm the workflow executes this suite on a pull request, and add or update the CI configuration if it does not yet run them. (Editing the CI config is part of the work; running CI is not — the platform does that.)',
  PLATFORM_DELIVERY_CONTRACT,
].join('\n')

const SYSTEM_PROMPTS: Record<AcceptanceAgentKind, string> = {
  playwright: [
    'You are a test automation engineer owning the runnable ACCEPTANCE TESTS for a building block.',
    'Translate the agreed acceptance scenarios into runnable tests that live in the repository.',
    '',
    'Pick the test tool to match the surface under test:',
    '- Frontend / user-facing UI: write Playwright end-to-end tests that drive the app through the browser.',
    "- Backend (services, APIs, queues, integrations, data): write the acceptance tests with the project's EXISTING test framework — discover it from the repository (test config, dev dependencies, the tests already present) and match it. Do not pull in Playwright or a browser for behaviour that has no UI.",
    'The run context below states the test approach for this specific block; follow it.',
    '',
    'Approach:',
    '- Treat the acceptance scenarios as the source of truth: prefer the Gherkin scenarios in `spec/features/*.feature` when present (each `Scenario` becomes one runnable test, named after it), else the scenarios provided above. One test per scenario so the mapping is obvious.',
    '- Be additive and idempotent: only create tests for scenarios that do not already have one; never duplicate or silently rewrite an existing test.',
    '- Exercise the system through its outermost interface and assert on observable behaviour — user-facing locators (roles, labels, text) for UI, public API / HTTP / message contracts for backend — never on internal implementation.',
    '- Keep tests isolated and deterministic: no shared mutable state, await every action, and rely on auto-retrying assertions instead of fixed sleeps.',
    '- Reach the system under test at the URL / entry point from the run context; read any access credentials from the harness, never hard-code secrets.',
    '- Output the test files to commit, each in the conventional test directory for its tool (e.g. the e2e/Playwright directory for UI tests), ready to run in CI.',
    '',
    PLAYWRIGHT_DELIVERY_GATE,
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
}

/** True when the agent kind is part of the acceptance-testing track. */
export function isAcceptanceKind(kind: AgentKind): kind is AcceptanceAgentKind {
  return kind === 'playwright'
}

/**
 * The built-out system (role) prompt for an acceptance-testing agent kind, or
 * `undefined` when the kind is not part of this track (so callers can fall
 * through to the standard phases / generic role).
 */
export function acceptanceSystemPrompt(kind: AgentKind): string | undefined {
  return isAcceptanceKind(kind) ? SYSTEM_PROMPTS[kind] : undefined
}

// Where the generated tests run is a per-block choice, so it is dynamic context
// rather than part of the static role prompt. These blurbs tell the agent how
// to wire and where to point the tests for each target.
const TEST_TARGET_GUIDANCE: Record<E2eTarget, string> = {
  ci: [
    'Test execution target: project CI (GitHub Actions).',
    '- Add the tests to the project so they run in a GitHub Actions workflow on each push / pull request.',
    '- Spin the system under test up inside the same workflow run (e.g. a build/start step or a `services:` container) and wait for it to be healthy before the tests run.',
    '- Point Playwright at the locally started service (e.g. http://localhost:<port>) via its config/baseURL; do not rely on an external environment.',
  ].join('\n'),
  ephemeral: [
    'Test execution target: the provisioned ephemeral environment for this run.',
    '- Run the tests against the ephemeral environment URL from the run context, not a locally started service.',
    '- Read any access credentials for that environment from the test harness/secrets; never hard-code them.',
    '- Assume the environment is already deployed and healthy before the tests start.',
  ].join('\n'),
}

/**
 * The "where do the tests run" section for an acceptance-testing step, rendered
 * from the block's contributed `playwright.e2eTarget` config value. Empty for
 * non-track kinds or when no target is recorded, so callers can append it
 * unconditionally.
 */
export function testTargetSection(context: AgentRunContext): string {
  if (!isAcceptanceKind(context.agentKind)) return ''
  const raw = context.block.agentConfig?.[PLAYWRIGHT_E2E_TARGET_CONFIG_ID]
  const target: E2eTarget | undefined = raw === 'ci' || raw === 'ephemeral' ? raw : undefined
  if (!target) return ''
  return `\n${TEST_TARGET_GUIDANCE[target]}`
}

// Block types whose behaviour is exercised through a browser UI, so the runnable
// tests should be Playwright e2e. Everything else is backend behaviour that gets
// tested with the project's own framework. Mirrors how the `playwright.e2e`
// best-practice fragment is scoped in @cat-factory/prompt-fragments.
const UI_BLOCK_TYPES: readonly BlockType[] = ['frontend', 'environment']

const UI_TEST_APPROACH = [
  'Test approach for this block: Playwright end-to-end tests.',
  '- This block has a user-facing surface, so cover its scenarios with Playwright tests that drive the app through the browser.',
  '- Select elements by user-facing locators (getByRole, getByLabel, getByText) and assert on what the user observes.',
].join('\n')

const BACKEND_TEST_APPROACH = [
  "Test approach for this block: the project's existing test framework (do NOT use Playwright).",
  '- This block has no user-facing UI, so do not add Playwright or a browser to it.',
  "- Discover the test framework already used in the repository (test config, dev dependencies, the tests already present) and write the acceptance tests with it, matching the project's conventions.",
  '- Drive the system through its public interface (API / HTTP calls, queue messages, exported functions) and assert on observable behaviour, never on internals.',
].join('\n')

/**
 * The "how should these tests be written" section for the runnable-tests step
 * (`playwright` kind), chosen from the block type: Playwright for user-facing
 * blocks, the project's own test framework for backend blocks. Empty for the
 * scenario-writing step and any non-track kind, so callers can append it
 * unconditionally. The scenario author stays framework-agnostic by design.
 */
export function testApproachSection(context: AgentRunContext): string {
  if (context.agentKind !== 'playwright') return ''
  const isUi = UI_BLOCK_TYPES.includes(context.block.type)
  return `\n${isUi ? UI_TEST_APPROACH : BACKEND_TEST_APPROACH}`
}
