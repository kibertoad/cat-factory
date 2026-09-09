import { describe, expect, it } from 'vitest'
import { renderIntegrationTestDigest } from './integrationTest.logic.js'

describe('renderIntegrationTestDigest', () => {
  it('renders the tests, the doubles they run against and the stated gaps', () => {
    const digest = renderIntegrationTestDigest({
      outcome: 'covered',
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
})
