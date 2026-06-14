import type { AgentKind, TestTarget } from '../../domain/types'
import type { AgentRunContext } from '../../ports/agent-executor'

// Built-out role prompts for the acceptance-testing agents. These two kinds turn
// requirements into executable end-to-end coverage in two steps:
//
//   - `acceptance` reads the block intent and any linked requirements / PRDs and
//     writes black-box acceptance test SCENARIOS in Given / When / Then form.
//   - `playwright` reads those scenarios and emits Playwright end-to-end TESTS,
//     committed to the repository, adding only tests that do not exist yet.
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

const STANDARDS_FOOTER =
  'Treat every best-practice standard appended below as a hard requirement, not a suggestion.'

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
    'You are a test automation engineer owning the PLAYWRIGHT end-to-end tests for a building block.',
    'Translate the agreed acceptance scenarios into runnable Playwright tests that live in the repository.',
    '',
    'Approach:',
    '- Treat the acceptance scenarios above as the source of truth: one `test` per scenario, named after the scenario so the mapping is obvious.',
    '- Be additive and idempotent: only create tests for scenarios that do not already have one; never duplicate or silently rewrite an existing test.',
    '- Drive the app through user-facing locators (roles, labels, text) — not brittle CSS or XPath — and assert on what the user observes.',
    '- Keep tests isolated and deterministic: no shared mutable state, await every action, and rely on web-first assertions instead of fixed sleeps.',
    '- Reach the system under test at the ephemeral environment URL from the run context; read any access credentials from the harness, never hard-code secrets.',
    '- Output the test files to commit, each under the e2e/Playwright test directory, ready to run in CI.',
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
