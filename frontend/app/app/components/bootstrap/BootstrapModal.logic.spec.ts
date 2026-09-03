import { describe, expect, it } from 'vitest'
import {
  defaultBootstrapDelivery,
  serviceDirectoryLeaf,
  serviceDirectoryParent,
} from '~/components/bootstrap/BootstrapModal.logic'

// The rule these two pin is what makes the field browsable AND typable at once: the tree hands
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

describe('defaultBootstrapDelivery', () => {
  it('reviews a monorepo and pushes a repository being created', () => {
    // The form has to SHOW the default it is about to send, and the two targets want opposite
    // ones, so a constant would render the wrong answer for one of them and ask the person to
    // correct a choice they never made. Same rule the backend applies to a request naming none.
    expect(defaultBootstrapDelivery(true)).toBe('pull_request')
    expect(defaultBootstrapDelivery(false)).toBe('direct_push')
  })
})
