import { describe, expect, it } from 'vitest'
import type { CustomManifestType } from '@cat-factory/contracts'
import {
  canSaveDefaultProvisioning,
  needsDefaultProvisioningChoice,
  suggestDefaultProvisioning,
} from './defaultProvisioning'

function customType(
  manifestId: string,
  source: CustomManifestType['source'] = 'registered',
): CustomManifestType {
  return { manifestId, label: manifestId, source }
}

describe('needsDefaultProvisioningChoice', () => {
  it('an unset default still owes a decision', () => {
    expect(needsDefaultProvisioningChoice({ defaultProvisionType: null })).toBe(true)
  })

  it('an explicit infraless is a decision, not an absence', () => {
    // The case that separates "nobody chose" from "we chose no environments" — get this wrong
    // and a workspace that deliberately runs infraless is nagged forever.
    expect(needsDefaultProvisioningChoice({ defaultProvisionType: 'infraless' })).toBe(false)
  })

  it('any recorded type settles it', () => {
    expect(needsDefaultProvisioningChoice({ defaultProvisionType: 'kubernetes' })).toBe(false)
  })
})

describe('suggestDefaultProvisioning', () => {
  const unset = { defaultProvisionType: null, defaultProvisionManifestId: null }

  it('opens on the recorded choice rather than re-suggesting over it', () => {
    expect(
      suggestDefaultProvisioning(
        { defaultProvisionType: 'kubernetes', defaultProvisionManifestId: null },
        [customType('acme-preview')],
      ),
    ).toEqual({ type: 'kubernetes', manifestId: null })
  })

  it('round-trips a recorded custom choice with its manifest id', () => {
    expect(
      suggestDefaultProvisioning(
        { defaultProvisionType: 'custom', defaultProvisionManifestId: 'acme-preview' },
        [customType('acme-preview'), customType('other')],
      ),
    ).toEqual({ type: 'custom', manifestId: 'acme-preview' })
  })

  it('suggests the first registered custom provider when nothing is selected', () => {
    expect(
      suggestDefaultProvisioning(unset, [customType('acme-preview'), customType('acme-legacy')]),
    ).toEqual({ type: 'custom', manifestId: 'acme-preview' })
  })

  it('prefers a registered provider over a hand-authored workspace type', () => {
    // A registered type is a deployment-level integration; a workspace row is one someone typed
    // into the UI. Order in the catalog must not decide which one we recommend.
    expect(
      suggestDefaultProvisioning(unset, [
        customType('typed-by-hand', 'workspace'),
        customType('acme-preview', 'registered'),
      ]),
    ).toEqual({ type: 'custom', manifestId: 'acme-preview' })
  })

  it('falls back to a workspace-defined type when no provider is registered', () => {
    expect(suggestDefaultProvisioning(unset, [customType('typed-by-hand', 'workspace')])).toEqual({
      type: 'custom',
      manifestId: 'typed-by-hand',
    })
  })

  it('suggests nothing when there are no custom providers at all', () => {
    // Deliberately does NOT guess a built-in: the picker offering `kubernetes` says nothing
    // about whether this workspace's services actually use it.
    expect(suggestDefaultProvisioning(unset, [])).toEqual({ type: null, manifestId: null })
  })
})

describe('canSaveDefaultProvisioning', () => {
  it('refuses an empty selection', () => {
    expect(canSaveDefaultProvisioning({ type: null, manifestId: null })).toBe(false)
  })

  it('refuses custom with no manifest id, mirroring the server rule', () => {
    expect(canSaveDefaultProvisioning({ type: 'custom', manifestId: null })).toBe(false)
  })

  it('accepts custom once a manifest type is named', () => {
    expect(canSaveDefaultProvisioning({ type: 'custom', manifestId: 'acme-preview' })).toBe(true)
  })

  it('accepts a built-in type, including infraless', () => {
    expect(canSaveDefaultProvisioning({ type: 'infraless', manifestId: null })).toBe(true)
  })
})
