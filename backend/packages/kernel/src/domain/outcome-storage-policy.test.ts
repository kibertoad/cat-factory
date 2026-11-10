import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTCOME_INLINE_MAX_BYTES } from '@cat-factory/contracts'
import { placeOutcomeBody, resolveOutcomeStoragePolicy } from './outcome-storage-policy.js'

const CEILING = 2_000_000

describe('resolveOutcomeStoragePolicy', () => {
  it('defaults when no tier sets anything', () => {
    expect(resolveOutcomeStoragePolicy({ facadeInlineCeilingBytes: CEILING })).toEqual({
      inlineMaxBytes: DEFAULT_OUTCOME_INLINE_MAX_BYTES,
      offload: 'enabled',
      facadeInlineCeilingBytes: CEILING,
    })
  })

  it('lets the narrowest tier that sets a field win, field by field', () => {
    expect(
      resolveOutcomeStoragePolicy({
        account: { inlineMaxBytes: 1000, offload: 'disabled' },
        workspace: { inlineMaxBytes: 2000 },
        project: { offload: 'enabled' },
        facadeInlineCeilingBytes: CEILING,
      }),
    ).toEqual({ inlineMaxBytes: 2000, offload: 'enabled', facadeInlineCeilingBytes: CEILING })
  })

  it('never raises the threshold past the facade ceiling', () => {
    expect(
      resolveOutcomeStoragePolicy({
        account: { inlineMaxBytes: 1_500_000 },
        facadeInlineCeilingBytes: 1_000_000,
      }).inlineMaxBytes,
    ).toBe(1_000_000)
  })
})

describe('placeOutcomeBody', () => {
  const policy = resolveOutcomeStoragePolicy({
    account: { inlineMaxBytes: 100 },
    facadeInlineCeilingBytes: 1000,
  })

  it('keeps a body at or under the threshold inline', () => {
    expect(
      placeOutcomeBody({
        bytes: 100,
        policy,
        blobStoreAvailable: true,
      }),
    ).toEqual({ placement: 'inline' })
  })

  it('offloads above the threshold when a store is available', () => {
    expect(
      placeOutcomeBody({
        bytes: 101,
        policy,
        blobStoreAvailable: true,
      }),
    ).toEqual({ placement: 'offload' })
  })

  it('keeps an over-threshold body inline when it cannot offload but fits the ceiling', () => {
    expect(
      placeOutcomeBody({
        bytes: 500,
        policy,
        blobStoreAvailable: false,
      }),
    ).toEqual({ placement: 'inline' })
    expect(
      placeOutcomeBody({
        bytes: 500,
        policy: { ...policy, offload: 'disabled' },
        blobStoreAvailable: true,
      }),
    ).toEqual({ placement: 'inline' })
  })

  it('refuses a body over the ceiling that cannot be offloaded, rather than truncating it', () => {
    expect(
      placeOutcomeBody({
        bytes: 1001,
        policy,
        blobStoreAvailable: false,
      }),
    ).toEqual({ placement: 'refused', reason: 'outcome_too_large_for_inline' })
  })
})
