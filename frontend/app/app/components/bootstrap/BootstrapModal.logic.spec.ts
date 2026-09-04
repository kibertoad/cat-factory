import { describe, expect, it } from 'vitest'
import {
  defaultBootstrapDelivery,
  referenceRefusalOf,
  referenceRefusalSurvivesSave,
  serviceDirectoryLeaf,
  serviceDirectoryParent,
} from '~/components/bootstrap/BootstrapModal.logic'

// The rule the first two pin is what makes the field browsable AND typable at once: the tree hands
// back the folder it was standing in plus the leaf, so a name someone typed has to survive a
// trip through the tree. Reading the leaf off the service name instead would silently discard it.

describe('serviceDirectoryLeaf', () => {
  it('is the typed path’s own last segment, not the service name', () => {
    expect(serviceDirectoryLeaf('services/billing', 'payments')).toBe('billing')
  })

  it('treats a bare name as the leaf (a directory at the repo root)', () => {
    expect(serviceDirectoryLeaf('billing', 'payments')).toBe('billing')
  })

  it('survives a trailing slash rather than reading as an empty leaf', () => {
    expect(serviceDirectoryLeaf('services/billing/', 'payments')).toBe('billing')
  })

  it('falls back to the service name while the field is still blank', () => {
    expect(serviceDirectoryLeaf('', 'payments')).toBe('payments')
    expect(serviceDirectoryLeaf('   ', '  payments  ')).toBe('payments')
  })

  it('is empty when neither is known, so the tree can say it has nothing to place', () => {
    expect(serviceDirectoryLeaf('', '')).toBe('')
  })
})

describe('serviceDirectoryParent', () => {
  it('is the folder the typed path sits in', () => {
    expect(serviceDirectoryParent('packages/services/billing')).toBe('packages/services')
  })

  it('is the repo root for a bare name', () => {
    expect(serviceDirectoryParent('billing')).toBe('')
    expect(serviceDirectoryParent('')).toBe('')
  })
})

// The refusal a launch can come back with. Both halves are read off ONE wire envelope and the
// stakes are the same in either direction: a banner that is dropped while it is still true takes
// away the only pointer to the broken entry, and one kept after it is fixed reads as a live error.
describe('referenceRefusalOf', () => {
  /** The envelope shape the contract client throws, as `apiErrorEnvelope` reads it. */
  const failure = (details: Record<string, unknown>) => ({ body: { error: { details } } })

  it('reads the reason and the two fields that name the offending entry', () => {
    expect(
      referenceRefusalOf(
        failure({
          reason: 'reference_repo_not_found',
          referenceArchitectureId: 'ref_1',
          repo: 'acme/service-template',
        }),
      ),
    ).toEqual({
      reason: 'reference_repo_not_found',
      architectureId: 'ref_1',
      repo: 'acme/service-template',
    })
  })

  it('keeps the two reasons apart, since only one of them means the entry is wrong', () => {
    expect(referenceRefusalOf(failure({ reason: 'reference_repo_unreadable' }))?.reason).toBe(
      'reference_repo_unreadable',
    )
  })

  it('is null for every other failure, so an unrelated error never shows this banner', () => {
    expect(referenceRefusalOf(failure({ reason: 'github_not_connected' }))).toBeNull()
    expect(referenceRefusalOf(failure({}))).toBeNull()
    expect(referenceRefusalOf(new Error('network down'))).toBeNull()
    expect(referenceRefusalOf(undefined)).toBeNull()
  })

  it('answers null for the ids rather than trusting whatever the field held', () => {
    // The refusal drives a jump to one entry, so a non-string id must not reach the lookup as one.
    expect(
      referenceRefusalOf(
        failure({ reason: 'reference_repo_not_found', referenceArchitectureId: 7, repo: null }),
      ),
    ).toEqual({ reason: 'reference_repo_not_found', architectureId: null, repo: null })
  })
})

describe('referenceRefusalSurvivesSave', () => {
  const refusal = {
    reason: 'reference_repo_not_found',
    architectureId: 'ref_1',
    repo: 'acme/service-template',
  } as const

  it('is cleared by saving the entry it named: that entry no longer reads the way it did', () => {
    expect(referenceRefusalSurvivesSave('ref_1', refusal)).toBe(false)
  })

  it('survives an edit to a DIFFERENT entry, which changed nothing about this claim', () => {
    expect(referenceRefusalSurvivesSave('ref_2', refusal)).toBe(true)
  })

  it('survives CREATING an entry beside the refused one', () => {
    // The case that lost the banner: adding an architecture while the refused one is still
    // selected and still unreachable, so the next launch fails again with nothing pointing at it.
    expect(referenceRefusalSurvivesSave(null, refusal)).toBe(true)
    expect(referenceRefusalSurvivesSave(undefined, refusal)).toBe(true)
  })

  it('has nothing to survive when no refusal stands', () => {
    expect(referenceRefusalSurvivesSave('ref_1', null)).toBe(false)
  })
})

describe('defaultBootstrapDelivery', () => {
  it('reviews a monorepo and pushes a repository being created', () => {
    // The form has to SHOW the default it is about to send, and the two targets want opposite
    // ones, so a constant would render the wrong answer for one of them and ask the person to
    // correct a choice they never made. Same rule the backend applies to a request naming none.
    expect(defaultBootstrapDelivery(true)).toBe('pull_request')
    expect(defaultBootstrapDelivery(false)).toBe('direct_push')
  })
})
