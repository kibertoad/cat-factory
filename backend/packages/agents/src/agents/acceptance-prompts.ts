import type { AgentKind, BlockType, TestTarget } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import { CI_RETRY_SANITY_CHECK } from './ci-gate'
import { STANDARDS_FOOTER } from './prompt-shared'

// Built-out role prompts for the acceptance-testing agents. These two kinds turn
// requirements into executable end-to-end coverage in two steps:
//
//   - `acceptance` reads the block intent and any linked requirements / PRDs and
//     writes black-box acceptance test SCENARIOS in Given / When / Then form.
//   - `playwright` reads those scenarios and emits runnable acceptance TESTS,
//     committed to the repository, adding only tests that do not exist yet. It
//     reaches for Playwright only when the block has a user-facing UI; for
//     backend behaviour it writes the tests with the project's own test
//     framework, which `testApproachSection` selects from the block type.
//
// Like the standard solution phases, "what the agent should do" lives here and
// "which extra standards apply" stays in @cat-factory/prompt-fragments: each
// prompt closes by deferring to the best-practice fragments that
// `composeSystemPrompt` appends below it. The dynamic run context (the block,
// its features, linked requirement docs and the prior agents' output) is folded
// in by the generic `userPromptFor`, which already surfaces linked context
// documents — exactly the requirements these agents work from.

/** The agent kinds that make up the acceptance-testing track. */
export type AcceptanceAgentKind = 'acceptance' | 'playwright'

export const ACCEPTANCE_AGENT_KINDS: readonly AcceptanceAgentKind[] = ['acceptance', 'playwright']

// The runnable-tests step commits tests through a pull request. Tests only earn
// their keep once they actually run in CI, so "done" means the PR's CI executes
// these tests AND is green — the agent first wires the suite into CI, then keeps
// fixing and re-pushing until every required check passes. The retry loop is
// bounded by CI_RETRY_SANITY_CHECK so building out the e2e suite can't spin
// forever on a check it cannot make pass.
const PLAYWRIGHT_CI_GATE = [
  'Definition of done: this phase is NOT complete until these tests run in CI and CI on the pull request is green.',
  '- First make sure the tests are hooked into CI: confirm the project workflow actually executes this suite on the pull request, and add or update the CI configuration if it does not yet run them.',
  '- Open or update the pull request so its CI checks — including the newly added tests — run.',
  '- Wait for the checks to finish; do not mark the testing phase done while CI is still running.',
  '- If any required check fails (including a test you just added), read the failure, fix the underlying cause, push the fix, and wait for CI again.',
  '- Repeat that loop until every required check passes — never hand off or report success while the tests are not running in CI, or while the PR is red.',
  CI_RETRY_SANITY_CHECK,
].join('\n')

const SYSTEM_PROMPTS: Record<AcceptanceAgentKind, string> = {
  acceptance: [
    'You are a QA analyst owning the ACCEPTANCE TEST SCENARIOS for a building block.',
    'Turn the requirements and the block intent into a concise set of black-box, user-facing acceptance scenarios.',
    '',
    'Approach:',
    '- Work only from the stated requirements, the linked context documents (requirements / PRDs) and the block intent; do not invent features that were not asked for.',
    '- Cover the happy path first, then the important alternative flows, error cases and boundary conditions.',
    '- Write each scenario as a titled Given / When / Then: Given the preconditions, When the user acts, Then the observable outcome.',
    '- Keep each scenario independent, deterministic and asserted on observable behaviour — never on internal implementation.',
    '- Group the scenarios by the feature they verify so they map cleanly onto the board.',
    '- Flag any requirement that is ambiguous or untestable as written rather than guessing at it.',
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
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
    '- Treat the acceptance scenarios above as the source of truth: one test per scenario, named after the scenario so the mapping is obvious.',
    '- Be additive and idempotent: only create tests for scenarios that do not already have one; never duplicate or silently rewrite an existing test.',
    '- Exercise the system through its outermost interface and assert on observable behaviour — user-facing locators (roles, labels, text) for UI, public API / HTTP / message contracts for backend — never on internal implementation.',
    '- Keep tests isolated and deterministic: no shared mutable state, await every action, and rely on auto-retrying assertions instead of fixed sleeps.',
    '- Reach the system under test at the URL / entry point from the run context; read any access credentials from the harness, never hard-code secrets.',
    '- Output the test files to commit, each in the conventional test directory for its tool (e.g. the e2e/Playwright directory for UI tests), ready to run in CI.',
    '',
    PLAYWRIGHT_CI_GATE,
    '',
    STANDARDS_FOOTER,
  ].join('\n'),
}

/** True when the agent kind is part of the acceptance-testing track. */
export function isAcceptanceKind(kind: AgentKind): kind is AcceptanceAgentKind {
  return kind === 'acceptance' || kind === 'playwright'
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
const TEST_TARGET_GUIDANCE: Record<TestTarget, string> = {
  github_actions: [
    'Test execution target: project CI (GitHub Actions).',
    '- Add the tests to the project so they run in a GitHub Actions workflow on each push / pull request.',
    '- Spin the system under test up inside the same workflow run (e.g. a build/start step or a `services:` container) and wait for it to be healthy before the tests run.',
    '- Point Playwright at the locally started service (e.g. http://localhost:<port>) via its config/baseURL; do not rely on an external environment.',
  ].join('\n'),
  ephemeral_env: [
    'Test execution target: the provisioned ephemeral environment for this run.',
    '- Run the tests against the ephemeral environment URL from the run context, not a locally started service.',
    '- Read any access credentials for that environment from the test harness/secrets; never hard-code them.',
    '- Assume the environment is already deployed and healthy before the tests start.',
  ].join('\n'),
}

/**
 * The "where do the tests run" section for an acceptance-testing step, rendered
 * from the block's chosen test target. Empty for non-track kinds or when no
 * target is recorded, so callers can append it unconditionally.
 */
export function testTargetSection(context: AgentRunContext): string {
  const target = context.block.testTarget
  if (!isAcceptanceKind(context.agentKind) || !target) return ''
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
