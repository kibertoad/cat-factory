import { describe, expect, it } from 'vitest'
import { rehydratedDraft } from './ServiceTestingContext.logic'

const TYPED = 'Sign in as $DEMO_USER. The seeded tenant is Acme.'

describe('rehydratedDraft', () => {
  it('follows the board while the operator has typed nothing of their own', () => {
    // A teammate saves in another tab: the live board event is the only thing that will ever tell
    // this textarea, so an untouched draft has to take it.
    const arrives = { draft: '', previous: '', incoming: TYPED, saving: false }
    expect(rehydratedDraft(arrives)).toBe(TYPED)
    expect(rehydratedDraft({ ...arrives, draft: 'old prose', previous: 'old prose' })).toBe(TYPED)
  })

  it('leaves an in-progress edit alone when someone else saves', () => {
    expect(
      rehydratedDraft({ draft: TYPED, previous: '', incoming: 'their prose', saving: false }),
    ).toBe(TYPED)
  })

  it('keeps unsaved prose through the whole of a REJECTED save', () => {
    // The sequence the board store produces for a first-time write that fails: the optimistic
    // patch announces our own text, then the rollback announces the value we started from. The
    // second one is the dangerous one, because by then the draft matches what the block last said
    // and the change reads exactly like a teammate's edit. Both land while `saving`.
    const optimistic = { draft: TYPED, previous: '', incoming: TYPED, saving: true }
    expect(rehydratedDraft(optimistic)).toBe(TYPED)
    const rolledBack = { draft: TYPED, previous: TYPED, incoming: '', saving: true }
    expect(rehydratedDraft(rolledBack)).toBe(TYPED)
  })

  it('keeps keystrokes typed while a save is in flight', () => {
    const stillTyping = `${TYPED} Never run the billing flow.`
    expect(
      rehydratedDraft({ draft: stillTyping, previous: '', incoming: TYPED, saving: true }),
    ).toBe(stillTyping)
  })
})
