import { describe, expect, it } from 'vitest'
import {
  integrationTestVerificationNote,
  renderIntegrationTestDigest,
} from './integrationTest.logic.js'

describe('renderIntegrationTestDigest', () => {
  it('renders the tests, the doubles they run against and the stated gaps', () => {
    const digest = renderIntegrationTestDigest({
      outcome: 'covered',
      committed: true,
      testPaths: ['test/billing/refund.spec.ts', '  '],
      mocks: ['mocks/mappings/psp-refund.json'],
      uncovered: ['the settlement webhook: no double for the provider callback'],
      notes: 'pnpm vitest run test/billing, wired into the pull-request workflow.',
    })!
    expect(digest).toContain('## Integration tests')
    expect(digest).toContain('Covered by committed tests')
    expect(digest).toContain('`test/billing/refund.spec.ts`')
    expect(digest).toContain('### Test doubles')
    expect(digest).toContain('`mocks/mappings/psp-refund.json`')
    // A gap is rendered UNDER a green verdict too: the two are not in tension, and a stated gap is
    // the one thing a reader cannot recover from anywhere else.
    expect(digest).toContain('### Not covered')
    expect(digest).toContain('no double for the provider callback')
    expect(digest).toContain('pnpm vitest run test/billing')
    // The blank path is dropped rather than rendered as an empty bullet.
    expect(digest).not.toContain('- ``')
  })

  it('renders an uncovered outcome with its reasons and no test list', () => {
    const digest = renderIntegrationTestDigest({
      outcome: 'uncovered',
      testPaths: [],
      mocks: [],
      uncovered: ['timing-dependent: the race needs two concurrent workers'],
    })!
    expect(digest).toContain('Not covered: no test was committed')
    expect(digest).not.toContain('### Tests')
    expect(digest).not.toContain('### Test doubles')
    expect(digest).toContain('two concurrent workers')
  })

  it('degrades a contentless object to the conservative outcome heading', () => {
    // An empty object coerces to `uncovered` (the schema's fallback), which is still worth putting
    // in front of the merge decision: it says there is no coverage to rely on.
    expect(renderIntegrationTestDigest({})!).toContain('Not covered')
  })

  it('returns undefined for an unparseable result so the raw reply is kept', () => {
    expect(renderIntegrationTestDigest('not json')).toBeUndefined()
    expect(renderIntegrationTestDigest(null)).toBeUndefined()
  })

  it('withdraws a coverage claim the run committed nothing behind, and says it did', () => {
    // The whole reason `committed` is on the record: the step tolerates a no-op, so an agent that
    // read the code, concluded the behaviour was already covered and pushed nothing settles
    // exactly as clean as one that wrote a suite. Rendering its claim unchallenged puts "Covered
    // by committed tests" over a diff containing none, in front of the merger and a human.
    const digest = renderIntegrationTestDigest({
      outcome: 'covered',
      committed: false,
      testPaths: ['test/billing/refund.spec.ts'],
      mocks: [],
      uncovered: [],
    })!
    expect(digest).toContain('Not covered: no test was committed')
    expect(digest).not.toContain('\nCovered by committed tests')
    // The claim is NAMED, not swallowed: which verdict the step asserted is the discrepancy.
    expect(digest).toContain('The step reported "Covered by committed tests"')
    // ...and the paths it named are still shown, under a heading that does not call them this
    // run's work.
    expect(digest).toContain('### Tests the step named')
  })

  it('leaves a claim alone when the harness reported no push outcome at all', () => {
    // `committed: undefined` is unknown, which is a third fact. Correcting on it would turn a
    // missing signal into a finding.
    const digest = renderIntegrationTestDigest({
      outcome: 'covered',
      testPaths: ['test/a.spec.ts'],
      mocks: [],
      uncovered: [],
    })!
    expect(digest).toContain('Covered by committed tests')
    expect(digest).not.toContain('pushed no files')
    expect(digest).toContain('### Tests')
  })

  it('neutralises markdown and scrubs secrets in the model-authored holes', () => {
    const digest = renderIntegrationTestDigest({
      outcome: 'partial',
      committed: true,
      testPaths: ['test/a.spec.ts'],
      mocks: [],
      uncovered: ['blocked on #4181, ask @security'],
      notes: ['```', 'token=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG'].join('\n'),
    })!
    expect(digest).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG')
    // The gap's auto-link triggers are defused, so a stated gap stays a statement rather than
    // becoming an event on somebody's issue and a mention of a team.
    expect(digest).not.toContain('#4181')
    expect(digest).not.toContain('@security')
    expect(digest).toContain('4181')
    // The fence the notes left open is closed again.
    expect(digest.match(/```/g)?.length ?? 0).toBe(2)
  })
})

describe('integrationTestVerificationNote', () => {
  const covered = {
    outcome: 'covered',
    committed: true,
    testPaths: ['test/a.spec.ts', 'test/b.spec.ts'],
    mocks: [],
    uncovered: ['the retry path'],
  }

  it('states the committed verification, its counts and the gate that runs it', () => {
    const note = integrationTestVerificationNote(covered, true)!
    expect(note).toContain('verified the change from the repository instead')
    expect(note).toContain('"Covered by committed tests"')
    expect(note).toContain('2 test files, 1 stated gap')
    expect(note).toContain('the CI gate is what runs those tests')
  })

  it('drops the CI promise when the pipeline carries no CI gate', () => {
    // The clause is the ENFORCEMENT half of the claim. Nothing obliges a pipeline carrying an
    // integration-test step to carry the gate, and promising a check that will never run is the
    // same defect as claiming a test run that never happened.
    const note = integrationTestVerificationNote(covered, false)!
    expect(note).not.toContain('CI gate')
    expect(note).toContain('"Covered by committed tests"')
  })

  it('states the absence, not a verification, when the step committed no coverage', () => {
    // `uncovered` is the documented tolerated outcome AND the value an unparseable reply degrades
    // to, so this is the branch a run reaches by degrading rather than by failing.
    const note = integrationTestVerificationNote(
      { outcome: 'uncovered', testPaths: [], mocks: [], uncovered: [] },
      true,
    )!
    expect(note).toContain('committed no coverage')
    expect(note).toContain('nothing here was exercised by the platform')
    expect(note).not.toContain('verified the change from the repository')
    expect(note).toContain('0 test files, 0 stated gaps')
  })

  it('reports a coverage claim the commits contradict as the absence it is', () => {
    const note = integrationTestVerificationNote(
      { outcome: 'covered', committed: false, testPaths: ['test/a.spec.ts'], mocks: [] },
      true,
    )!
    expect(note).toContain('nothing here was exercised by the platform')
    expect(note).toContain('over a branch it pushed nothing to')
  })

  it('answers nothing for a run with no readable integration-test outcome', () => {
    // The caller falls back to the plain no-tester absence, which is the truth there.
    expect(integrationTestVerificationNote(undefined, true)).toBeUndefined()
    expect(integrationTestVerificationNote('not json', true)).toBeUndefined()
  })
})
