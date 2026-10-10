import { describe, expect, it } from 'vitest'
import { systemPromptFor } from '../catalog.js'
import {
  INTEGRATION_TEST_KIND,
  integrationTestOutcome,
  integrationTestResult,
} from './integration-test.js'
import { defaultAgentKindRegistry } from './registry.js'
import { BRIEF_STANDARDS_TRAIT, CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT, hasTrait } from './traits.js'

// `defaultAgentKindRegistry()` pre-loads the integration-test kind, so a fresh instance exposes it
// (no module-global side effect).
const registry = defaultAgentKindRegistry()

describe('integration-test agent kind', () => {
  it('commits onto the work branch the coder already opened a pull request from', () => {
    const step = registry.agentStep(INTEGRATION_TEST_KIND)
    expect(step?.surface).toBe('container-coding')
    // The per-block work branch, which by this point in a run IS the pull request's head, so the
    // tests land on the pull request carrying the fix they cover.
    expect(step?.clone?.branch).toBe('work')
    // It never opens the run's pull request: the coder did that before it ran.
    expect(step?.opensPr).toBe(false)
    // Committing nothing is a reportable outcome, not a failed run: the fix is already pushed by
    // the time this step runs, so a gap belongs in its report rather than in a run failure.
    expect(step?.noChangesTolerated).toBe(true)
    expect(registry.requiresContainer(INTEGRATION_TEST_KIND)).toBe(true)
  })

  it('is offered as a first-class palette block in the testing group', () => {
    const presentation = registry.presentation(INTEGRATION_TEST_KIND)
    expect(presentation?.category).toBe('test')
    expect(presentation?.label).toBe('Integration Tests')
    expect(presentation?.description).toBeTruthy()
    // The structured outcome opens in the shared generic viewer: no bespoke result window.
    expect(presentation?.resultView).toBe('generic-structured')
  })

  it('carries the fragment traits a test-writing agentic loop needs', () => {
    // `code-aware` is what folds the service's best-practice fragments at all (a kind that clones a
    // repo without one has them silently dropped, see `context-trait-guard.test.ts`);
    // `brief-standards` folds the CONDENSED variant, which is the right trade for a long loop
    // whose system prompt is re-sent every turn; `spec-aware` points it at the in-repo spec, which
    // is what says which behaviour is established and therefore worth a regression test.
    expect(hasTrait(INTEGRATION_TEST_KIND, CODE_AWARE_TRAIT, registry)).toBe(true)
    expect(hasTrait(INTEGRATION_TEST_KIND, BRIEF_STANDARDS_TRAIT, registry)).toBe(true)
    expect(hasTrait(INTEGRATION_TEST_KIND, SPEC_AWARE_TRAIT, registry)).toBe(true)
  })

  it('states that no environment exists, and asks for the answer in the reply', () => {
    const prompt = systemPromptFor(INTEGRATION_TEST_KIND, registry)
    // The one instruction the whole kind exists for: there is no provisioned environment to test
    // through, and the tests have to run from the repository. A `container-coding` surface is
    // never handed environment coordinates, so the prompt has to say so rather than leave the
    // agent to notice.
    expect(prompt).toContain('This run stands NO environment up for you')
    // Its deliverable is BOTH a commit and a structured verdict. A pure side-effect coding kind
    // legitimately ends with no final text, which is why the coding surface withholds the
    // final-answer directive; this kind has to be given it back.
    expect(prompt).toContain('Your deliverable is the text of your FINAL reply')
  })

  it('degrades a malformed reply to "uncovered" rather than to a claim nobody made', () => {
    // Lenient in place, like `reproTestOutcome`: the commits are already pushed when this parses,
    // so a partially-broken reply must not fail the step. What it may not do is read as coverage:
    // an unreadable verdict answers `uncovered`, the conservative direction.
    expect(integrationTestOutcome.safeParse({ outcome: 'nonsense' })).toEqual({
      outcome: 'uncovered',
      testPaths: [],
      mocks: [],
      uncovered: [],
      notes: undefined,
      committed: undefined,
    })
    const parsed = integrationTestOutcome.safeParse({
      outcome: 'partial',
      testPaths: ['test/billing/refund.spec.ts'],
      mocks: ['mocks/mappings/psp-refund.json'],
      uncovered: ['the 3-day settlement window: needs production data'],
      notes: 'pnpm vitest run test/billing',
    })
    expect(parsed?.outcome).toBe('partial')
    expect(parsed?.uncovered).toEqual(['the 3-day settlement window: needs production data'])
  })

  it('never asks the model for the field the platform owns', () => {
    // `committed` is written by `integrationTestResult` from the harness's push outcome. Listing
    // it in the shape hint (what the harness shows the model when it repairs a malformed reply)
    // would invite the model to decide the question it is being checked against.
    expect(integrationTestOutcome.spec.shapeHint).toContain('"outcome"')
    expect(integrationTestOutcome.spec.shapeHint).not.toContain('committed')
  })

  it('records whether the run committed anything, over whatever the reply claimed', () => {
    const claim = { outcome: 'covered', testPaths: ['test/a.spec.ts'], committed: true }
    // A no-op run: `noChangesTolerated` lets it settle clean, so nothing else can tell a report of
    // committed tests from the same report over an empty diff.
    const noop = integrationTestResult({ custom: claim, pushed: false } as never)
    expect((noop.custom as { committed?: boolean }).committed).toBe(false)
    // A run whose tests landed in a CONNECTED service's repo did commit: `pushed` describes the
    // primary repo alone.
    const peer = integrationTestResult({
      custom: claim,
      pushed: false,
      peerPullRequests: [{ repo: 'acme/api', prUrl: 'https://host/pr/3' }],
    } as never)
    expect((peer.custom as { committed?: boolean }).committed).toBe(true)
    // Unknown stays unknown: a dispatch that reported no push outcome is a third fact.
    const silent = integrationTestResult({ custom: claim } as never)
    expect((silent.custom as { committed?: boolean }).committed).toBeUndefined()
  })
})
