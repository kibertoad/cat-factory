import { describe, expect, it } from 'vitest'
import { DEFAULT_FINDINGS_INLINE_MAX_BYTES } from '@cat-factory/contracts'
import { placeFindingsBody, resolveFindingsStoragePolicy } from './findings-storage-policy.js'

const CEILING = 2_000_000

describe('resolveFindingsStoragePolicy', () => {
  it('defaults when no tier sets anything', () => {
    expect(resolveFindingsStoragePolicy({ facadeInlineCeilingBytes: CEILING })).toEqual({
      inlineMaxBytes: DEFAULT_FINDINGS_INLINE_MAX_BYTES,
      offload: 'enabled',
      facadeInlineCeilingBytes: CEILING,
    })
  })

  it('lets the narrowest tier that sets a field win, field by field', () => {
    expect(
      resolveFindingsStoragePolicy({
        account: { inlineMaxBytes: 1000, offload: 'disabled' },
        workspace: { inlineMaxBytes: 2000 },
        project: { offload: 'enabled' },
        facadeInlineCeilingBytes: CEILING,
      }),
    ).toEqual({ inlineMaxBytes: 2000, offload: 'enabled', facadeInlineCeilingBytes: CEILING })
  })

  it('never raises the threshold past the facade ceiling', () => {
    expect(
      resolveFindingsStoragePolicy({
        account: { inlineMaxBytes: 1_500_000 },
        facadeInlineCeilingBytes: 1_000_000,
      }).inlineMaxBytes,
    ).toBe(1_000_000)
  })
})

describe('placeFindingsBody', () => {
  const policy = resolveFindingsStoragePolicy({
    account: { inlineMaxBytes: 100 },
    facadeInlineCeilingBytes: 1000,
  })

  it('keeps a body at or under the threshold inline', () => {
    expect(
      placeFindingsBody({
        bytes: 100,
        policy,
        blobStoreAvailable: true,
      }),
    ).toEqual({ placement: 'inline' })
  })

  it('offloads above the threshold when a store is available', () => {
    expect(
      placeFindingsBody({
        bytes: 101,
        policy,
        blobStoreAvailable: true,
      }),
    ).toEqual({ placement: 'offload' })
  })

  it('keeps an over-threshold body inline when it cannot offload but fits the ceiling', () => {
    expect(
      placeFindingsBody({
        bytes: 500,
        policy,
        blobStoreAvailable: false,
      }),
    ).toEqual({ placement: 'inline' })
    expect(
      placeFindingsBody({
        bytes: 500,
        policy: { ...policy, offload: 'disabled' },
        blobStoreAvailable: true,
      }),
    ).toEqual({ placement: 'inline' })
  })

  it('refuses a body over the ceiling that cannot be offloaded, rather than truncating it', () => {
    expect(
      placeFindingsBody({
        bytes: 1001,
        policy,
        blobStoreAvailable: false,
      }),
    ).toEqual({ placement: 'refused', reason: 'findings_too_large_for_inline' })
  })
})
