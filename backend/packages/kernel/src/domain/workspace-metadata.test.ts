import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceMetadata } from './workspace-metadata.js'

// The one piece of MEANING the store has about a custom-metadata bag: a field is either set to
// something, or it is not there at all. The editor renders every declared field, so a cleared
// input arrives as `''`; storing that would leave an external-tool resolver checking
// `ctx.metadata.gameId` building a URL with an empty id instead of reporting the field missing.

describe('normalizeWorkspaceMetadata', () => {
  it('trims a value, because a trailing space in a URL parameter is an invisible broken link', () => {
    expect(normalizeWorkspaceMetadata({ gameId: '  vg-42\t' })).toEqual({ gameId: 'vg-42' })
  })

  it('DROPS a key whose value is empty after trimming, rather than storing a blank', () => {
    expect(normalizeWorkspaceMetadata({ gameId: '', studio: '   ', keep: 'x' })).toEqual({
      keep: 'x',
    })
  })

  it('preserves a key no field currently declares', () => {
    // A deployment may have retired the field while the value it wrote still means something to
    // whatever reads it, so normalisation is not the place to decide a key is obsolete.
    expect(normalizeWorkspaceMetadata({ retiredField: 'still meaningful' })).toEqual({
      retiredField: 'still meaningful',
    })
  })

  it('returns a NEW bag rather than editing the submitted one in place', () => {
    const submitted = { gameId: ' vg-42 ', cleared: '' }
    const normalized = normalizeWorkspaceMetadata(submitted)
    expect(normalized).not.toBe(submitted)
    expect(submitted).toEqual({ gameId: ' vg-42 ', cleared: '' })
  })

  it('is total: an empty bag normalises to an empty bag', () => {
    expect(normalizeWorkspaceMetadata({})).toEqual({})
  })
})
