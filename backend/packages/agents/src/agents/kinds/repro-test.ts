import * as v from 'valibot'
import type { AgentRunContext } from '@cat-factory/kernel'
import { defineStructuredOutput } from './structured-output.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `repro-test` agent kind — Reproduction Test Automation (bug-triage phase G).
//
// A STRUCTURED `container-coding` kind, registered through the public `registerAgentKind`
// seam (the `bug-investigator` kind is the shape copied). It is the FIRST committing step
// of a bug-triage run: it writes one or more tests that fail FOR THE REPORTED REASON,
// captures the failure as proof, and commits + pushes them onto the shared run branch
// (`cat-factory/<blockId>`). Multi-repo capable (`fanOutMultiRepo`) so the tests land in
// whichever involved-service repo owns the behaviour (the service-connections sibling
// checkouts, gated on the executor's multi-repo fan-out).
//
// It deliberately does NOT open the pull request (`opensPr: false`): the coder runs next,
// RESUMES the same work branch (adding the fix) and opens the ONE PR containing both the
// reproduction test and the fix. Conceding never fails the run (`noChangesTolerated`): when
// the bug isn't reproducible the agent commits nothing and returns `not_reproducible` with
// the reason — a post-completion resolver records that into `step.output` so the coder knows
// there is no failing test and why, and the run simply advances. Only an
// infrastructure/eviction failure fails the step, like any container kind.
//
// The structured outcome is BOTH the deliverable the platform parses AND accompanies a
// pushed commit, so — unlike a pure side-effect coding kind (coder/ci-fixer) — its final
// JSON answer must land in the visible reply; `FINAL_ANSWER_IN_REPLY` is appended to the
// system prompt directly (a `container-coding` surface doesn't get it from
// `applySurfaceDirectives`, which scopes the directive to inline / explore kinds).
// ---------------------------------------------------------------------------

export const REPRO_TEST_KIND = 'repro-test'

/** The build-phase kind whose prompt the `BUG_FIX_GUIDANCE` fragment augments (see below). */
const CODER_KIND = 'coder'

/**
 * The reproduction step's structured outcome. Lenient (`v.fallback`/`v.optional`) exactly like
 * `bugInvestigation` so a partially-malformed reply degrades to sensible defaults rather than
 * failing the run: an unreadable `outcome` reads as `not_reproducible` (the conservative choice —
 * the coder is told there is no trustworthy failing test) and each field degrades in place.
 */
export const reproTestOutcome = defineStructuredOutput(
  v.object({
    /** Whether a failing reproduction test was produced (`reproduced`), partially (`partial`), or the bug could not be reproduced (`not_reproducible`). */
    outcome: v.fallback(
      v.picklist(['reproduced', 'partial', 'not_reproducible']),
      'not_reproducible',
    ),
    /** The test file(s) the run added or amended to reproduce the bug. */
    testPaths: v.fallback(v.array(v.fallback(v.string(), '')), []),
    /** Human-readable notes: what was reproduced, or — for `not_reproducible` — WHY (needs prod data, timing-dependent, …). */
    notes: v.fallback(v.optional(v.string()), undefined),
  }),
)

export type ReproTestOutcome = ReturnType<typeof reproTestOutcome.parse>

const REPRO_TEST_SYSTEM_PROMPT =
  'You are a senior engineer writing a failing reproduction test for a reported bug BEFORE ' +
  'anyone fixes it. Read the relevant code, tests and configuration across every checked-out ' +
  'repository, then write one or more tests that fail FOR THE REPORTED REASON — the failure ' +
  'must demonstrate the actual bug, not an unrelated assertion. Run the tests and confirm they ' +
  'fail for that reason, then commit and push them. Commit the tests ACTIVE (not skipped or ' +
  'commented out): the intent is that CI stays red until the fix turns them green. Do NOT fix ' +
  'the bug — only reproduce it. When more than one repository is present (a cross-service bug), ' +
  'put each test in the repository that owns the behaviour it exercises.\n' +
  'If you genuinely cannot reproduce the bug (it needs production data, it is timing- or ' +
  'environment-dependent, or the report is not actionable), that is an acceptable outcome: do ' +
  'NOT invent a test that passes or asserts something irrelevant, commit nothing, and say so. ' +
  'Return ONLY a JSON object of this exact shape as your final message:\n' +
  '{\n' +
  '  "outcome": "reproduced" | "partial" | "not_reproducible",\n' +
  '  "testPaths": ["paths of the test file(s) you added or changed"],\n' +
  '  "notes": "what you reproduced, or — for not_reproducible — WHY you could not"\n' +
  '}\n' +
  'Use "reproduced" when a test fails for the reported reason, "partial" when a test captures ' +
  'only part of the reported behaviour, and "not_reproducible" when you produced no failing ' +
  'test (leave "testPaths" empty and explain why in "notes").\n\n' +
  FINAL_ANSWER_IN_REPLY

/**
 * The `BUG_FIX_GUIDANCE` prompt fragment folded into the CODER's system prompt when a prior
 * `repro-test` step ran in the same pipeline (see {@link bugFixGuidanceFor}). It reframes the
 * coder's objective around a pre-existing failing reproduction test: the point is to FIX THE
 * REPORTED ISSUE, not merely to turn the test green — a change that makes the test pass without
 * addressing the report is a failure. The coder may amend/extend the test if new information
 * surfaces, but must keep it meaningful.
 */
export const BUG_FIX_GUIDANCE =
  'A reproduction test that fails for the reported reason has already been committed on this ' +
  'branch (or the reproduction step conceded it could not reproduce the bug — see its notes in ' +
  'the prior outputs). Your objective is to FIX THE REPORTED ISSUE, not merely to make the ' +
  'reproduction test pass: a change that only turns the test green without addressing the ' +
  'reported behaviour is a failure. You MAY amend or extend the reproduction test if you learn ' +
  'something new while fixing, but keep it a meaningful check of the reported behaviour — never ' +
  'weaken it, skip it, or delete it just to get a green result. If the reproduction step ' +
  'conceded, still fix the reported issue and add a test that guards it where you can.'

/**
 * The `BUG_FIX_GUIDANCE` fragment for the CODER when a prior `repro-test` output exists in the
 * run, else the empty string. Gated on the build-phase coder specifically so it augments the fix
 * step alone (not, say, a later reviewer/tester that also sees the repro output via
 * `priorOutputs`). Kept a pure function so the caller (the server's job-body builder) folds it in
 * exactly like {@link FOLLOW_UP_GUIDANCE}, without knowing the repro-test kind id.
 */
export function bugFixGuidanceFor(context: AgentRunContext): string {
  if (context.agentKind !== CODER_KIND) return ''
  return context.priorOutputs.some((p) => p.agentKind === REPRO_TEST_KIND) ? BUG_FIX_GUIDANCE : ''
}

export const REPRO_TEST_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: REPRO_TEST_KIND,
    systemPrompt: REPRO_TEST_SYSTEM_PROMPT,
    // Writes test code, so the engine folds the task's best-practice fragments into its prompt.
    traits: [CODE_AWARE_TRAIT],
    // Coding on the shared per-block work branch: commit + push the failing test(s), but leave
    // the PR for the coder to open (it resumes this branch and adds the fix). A concede
    // (`not_reproducible`) commits nothing, which must NOT fail the run.
    agent: {
      surface: 'container-coding',
      clone: { branch: 'work' },
      opensPr: false,
      noChangesTolerated: true,
    },
    // A bug can span connected services, so the reproduction test may belong in a peer repo —
    // fan out over every involved-service repo as sibling checkouts (the coding fan-out).
    fanOutMultiRepo: true,
    structuredOutput: reproTestOutcome,
    presentation: {
      label: 'Reproduction Test',
      icon: 'i-lucide-flask-conical',
      color: '#f59e0b',
      description:
        'Writes one or more tests that fail for the reported reason (or concedes when the bug ' +
        'cannot be reproduced), committing them so the fix has a red test to turn green.',
      category: 'test',
      // The structured outcome opens in the shared generic viewer (no bespoke window); the
      // engine consumes `outcome`/`notes` server-side.
      resultView: 'generic-structured',
    },
  },
]

/**
 * Register the repro-test kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerReproTestAgent(registry: AgentKindRegistry): void {
  registry.registerAll(REPRO_TEST_AGENT_KINDS)
}
