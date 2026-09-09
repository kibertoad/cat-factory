import * as v from 'valibot'
import { defineStructuredOutput } from './structured-output.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { BRIEF_STANDARDS_TRAIT, CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `integration-test` agent kind: the automated coverage that PROVES a fix, written to run
// with no environment behind it.
//
// It exists because the platform had exactly two ways to establish that a change works, and both
// need a running system: the API/UI testers (which read a provisioned ephemeral environment) and
// the acceptance author (whose tests target that environment or the project CI). A deployment
// whose ephemeral environments are slow, expensive or simply not representative still wants a
// bugfix proven, and what proves it there is a test committed beside the fix, exercised against
// test doubles, re-run by the project's own CI on every change that follows.
//
// So this is a `container-coding` step rather than a tester: its deliverable is committed tests
// plus the doubles they run against, and the ENFORCEMENT is the `ci` gate that runs them for real.
// It is never handed environment coordinates (only the tester family is, see
// `runsAgainstEphemeralEnvironment`), which is what makes "write something that runs from the
// repository alone" a fact about the dispatch rather than a request in a prompt.
//
// Placed AFTER the coder, so it reads the fix it covers. It resumes the same per-block work branch
// (`opensPr: false`: the coder already opened the run's pull request) and its commits land on that
// pull request. Producing nothing is tolerated (`noChangesTolerated`) and reported structurally as
// `uncovered`: by the time this step runs the fix is committed and pushed, so failing the run over
// absent coverage would throw the work away instead of naming the gap for the human at the merge
// gate. `pl_bugfix_tested` is the preset built around it
// (`backend/docs/test-verified-bugfix.md`).
// ---------------------------------------------------------------------------

export const INTEGRATION_TEST_KIND = 'integration-test'

/**
 * The step's structured outcome. Lenient (`v.fallback`/`v.optional`) exactly like
 * `reproTestOutcome`, so a partially-malformed reply degrades in place rather than failing a step
 * whose commits are already pushed. An unreadable `outcome` reads as `uncovered`, the conservative
 * choice: a reader is then told there is no coverage to rely on rather than handed a claim the
 * reply never made.
 */
export const integrationTestOutcome = defineStructuredOutput(
  v.object({
    /** Whether the changed behaviour ended up covered by committed, passing tests. */
    outcome: v.fallback(v.picklist(['covered', 'partial', 'uncovered']), 'uncovered'),
    /** The test file(s) this run added or extended. */
    testPaths: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /**
     * The test doubles the tests run against, by path or by the upstream each stands in for: what
     * this run added plus what it reused. Named rather than implied because the next person to
     * touch these tests has to know which stubs they lean on, and because a set of integration
     * tests naming NO double is either reaching a real third party or not integrating anything.
     */
    mocks: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /**
     * Behaviour this run deliberately did NOT cover, each entry carrying its reason. The honest
     * half of the report, and the reason `outcome` alone is not the deliverable: `partial` with an
     * empty list states a gap while hiding what it is, which reads to a reviewer exactly like
     * coverage nobody got round to describing.
     */
    uncovered: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /** What the committed tests exercise, and the command or CI job that runs them. */
    notes: v.fallback(v.optional(v.string()), undefined),
  }),
)

export type IntegrationTestOutcome = ReturnType<typeof integrationTestOutcome.parse>

const INTEGRATION_TEST_SYSTEM_PROMPT = [
  'You are an integration-test engineer. A fix for a reported defect has just been committed on this branch, and your job is to leave behind the automated tests that prove the fixed behaviour holds and that fail again if it ever regresses.',
  'This run stands NO environment up for you: there is no deployed URL to point at, and nobody is going to exercise this service by hand. Everything you write has to run from the repository itself, against test doubles for whatever the code reaches over the network.',
  '',
  'How to work:',
  '- Read the defect report, the reproduction test if an earlier step committed one, and the fix on this branch before you write anything.',
  "- Use the project's OWN test framework and layout. Discover it from the test configuration, the dev dependencies and the tests already present, and match how the existing integration tests are written. Do not introduce a second test runner, and do not reach for a browser to cover behaviour that has no user interface.",
  '- Test at the INTEGRATION level: drive the change through the seam a caller really uses (the HTTP route, the message handler, the exported entry point) with its in-process collaborators wired up, rather than asserting on internals or re-testing one private function.',
  '- Stub every EXTERNAL dependency at its boundary: third-party and partner APIs, other services reached over the network, payment, email and identity providers. Reuse the stub mappings and fixtures already in the repository (a preceding mock step may have added some) and extend those, rather than standing up a second competing set. Never stub the code under test, and for owned infrastructure (a database, a cache, a queue) prefer the real local instance the suite already runs.',
  '- Cover the reported behaviour first, then the neighbouring cases this fix could plausibly have broken and the error paths it introduced. Keep every test deterministic: no sleeps, no shared mutable state, no dependence on the order tests run in.',
  "- RUN what you wrote, get it passing against the fix, then commit and push. Check that the project's CI configuration actually executes these tests on a pull request, and add them to it if it does not: CI running them is what turns them into the check that guards this fix.",
  '- Never weaken, skip or delete an existing test to reach a green result, the earlier reproduction test included.',
  '- If part of the reported behaviour genuinely cannot be covered here (it needs production data, it is timing-dependent, the seam has no usable test double), record it in "uncovered" with the reason instead of writing a test that asserts something else. A stated gap is worth more than a weakened test that passes.',
  '',
  'Return ONLY a JSON object of this exact shape as your final message:',
  '{',
  '  "outcome": "covered" | "partial" | "uncovered",',
  '  "testPaths": ["paths of the test file(s) you added or changed"],',
  '  "mocks": ["the stubs, fakes or fixtures your tests run against, added or reused"],',
  '  "uncovered": ["behaviour you did not cover, each with the reason why"],',
  '  "notes": "what the tests exercise, and the command or CI job that runs them"',
  '}',
  'Use "covered" when the reported behaviour is exercised by committed, passing tests, "partial" when only some of it is, and "uncovered" when you committed no test at all (then leave "testPaths" empty and explain yourself in "uncovered").',
  '',
  FINAL_ANSWER_IN_REPLY,
].join('\n')

export const INTEGRATION_TEST_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: INTEGRATION_TEST_KIND,
    systemPrompt: INTEGRATION_TEST_SYSTEM_PROMPT,
    // Writes test code to the service's own conventions, so the task's best-practice fragments are
    // folded in, in their CONDENSED form: this is a long agentic loop (write, run, read the
    // failure, adjust) whose system prompt is re-sent every turn, which is the shape
    // `brief-standards` exists for. `spec-aware` because the in-repo spec is what says which
    // behaviour is established, and therefore which regressions are worth a test.
    traits: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT, BRIEF_STANDARDS_TRAIT],
    agent: {
      surface: 'container-coding',
      clone: { branch: 'work' },
      opensPr: false,
      noChangesTolerated: true,
    },
    // A defect can span connected services, so the tests may belong in a peer repo: fan out over
    // every involved-service repo as sibling checkouts, exactly as the reproduction step and the
    // coder do.
    fanOutMultiRepo: true,
    structuredOutput: integrationTestOutcome,
    presentation: {
      label: 'Integration Tests',
      icon: 'i-lucide-test-tubes',
      color: '#22d3ee',
      description:
        'Writes the integration tests and test doubles that prove a change works, run from the ' +
        'repository with no environment behind them, and states what it could not cover.',
      category: 'test',
      tier: 'intermediate',
      // The structured outcome opens in the shared generic viewer; the engine folds a digest of it
      // into `step.output` for the steps that follow.
      resultView: 'generic-structured',
    },
  },
]

/**
 * Register the integration-test kind on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerIntegrationTestAgent(registry: AgentKindRegistry): void {
  registry.registerAll(INTEGRATION_TEST_AGENT_KINDS)
}
