import { describe, expect, it } from 'vitest'
import { SAFE_AREA_GUTTER_CLASS, SAFE_AREA_INSET_CLASS } from '~/utils/safeArea'

// A missing or misspelled side is silent on every screen without a notch, so the exact spellings
// are pinned here.
describe('safe-area classes', () => {
  it('gives a windowed overlay 1rem or the inset, whichever is larger, on every side', () => {
    expect(SAFE_AREA_GUTTER_CLASS.split(' ')).toEqual([
      'pt-[max(1rem,env(safe-area-inset-top))]',
      'pr-[max(1rem,env(safe-area-inset-right))]',
      'pb-[max(1rem,env(safe-area-inset-bottom))]',
      'pl-[max(1rem,env(safe-area-inset-left))]',
    ])
  })

  it('gives a full-bleed overlay only the inset, so it stays edge to edge without one', () => {
    expect(SAFE_AREA_INSET_CLASS.split(' ')).toEqual([
      'pt-[env(safe-area-inset-top)]',
      'pr-[env(safe-area-inset-right)]',
      'pb-[env(safe-area-inset-bottom)]',
      'pl-[env(safe-area-inset-left)]',
    ])
  })
})
