import { describe, expect, it } from 'vitest'
import { FULL_BLEED_TAKEOVER_CLASS, WINDOWED_OVERLAY_CLASS } from '~/utils/safeArea'

// A missing or misspelled side is silent on every screen without a notch, so the exact spellings
// are pinned here. That every full-screen surface binds one of these is
// `scripts/check-frontend-safe-area.mjs`'s job.
describe('full-screen overlay root classes', () => {
  it('gives a takeover only the inset, so it stays edge to edge without one', () => {
    expect(FULL_BLEED_TAKEOVER_CLASS.split(' ')).toEqual([
      'fixed',
      'inset-0',
      'flex',
      'max-h-[100dvh]',
      'pt-[env(safe-area-inset-top)]',
      'pr-[env(safe-area-inset-right)]',
      'pb-[env(safe-area-inset-bottom)]',
      'pl-[env(safe-area-inset-left)]',
    ])
  })

  it('gives a windowed backdrop 1rem or the inset, whichever is larger, on every side', () => {
    expect(WINDOWED_OVERLAY_CLASS.split(' ')).toEqual([
      'fixed',
      'inset-0',
      'flex',
      'max-h-[100dvh]',
      'pt-[max(1rem,env(safe-area-inset-top))]',
      'pr-[max(1rem,env(safe-area-inset-right))]',
      'pb-[max(1rem,env(safe-area-inset-bottom))]',
      'pl-[max(1rem,env(safe-area-inset-left))]',
    ])
  })
})
