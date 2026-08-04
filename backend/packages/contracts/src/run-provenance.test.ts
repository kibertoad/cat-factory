import { describe, expect, it } from 'vitest'
import { intakeOriginSchema, isHeadlessIntake, type IntakeOrigin } from './run-provenance.js'

// `isHeadlessIntake` decides whether a parked review's questions are pushed OUT to where the work
// came from. Getting it wrong is silent in both directions: too narrow and a requester is never
// told their run is waiting on them; too wide and clarification questions land on a ticket nobody
// expects, or on one whose link is about to move. So the vocabulary is asserted as a WHOLE rather
// than member by member: a new intake surface has to appear in the table below, which is the
// point at which someone has to decide what it means.

const EXPECTED: Record<IntakeOrigin, boolean> = {
  ui: false,
  'public-api': true,
  tracker: true,
  schedule: false,
}

describe('isHeadlessIntake', () => {
  it('classifies every member of the vocabulary, and no more', () => {
    // Reads the picklist itself rather than restating it, so adding a member without deciding
    // what it means fails HERE instead of quietly inheriting a neighbour's answer.
    expect([...intakeOriginSchema.options].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it.each(Object.entries(EXPECTED))('classifies %s', (origin, headless) => {
    expect(isHeadlessIntake(origin as IntakeOrigin)).toBe(headless)
  })

  it('treats an origin outside the vocabulary as not headless, not as undefined', () => {
    // The value arrives off a run's persisted `detail` JSON, which outlives any member retired
    // from the picklist. The bare `Record` lookup answers `undefined` there, which the declared
    // `boolean` would hide until a caller wrote `=== false` and got a surprise.
    expect(isHeadlessIntake('mailbox' as IntakeOrigin)).toBe(false)
  })

  it('treats an absent origin as the in-app default, never as headless', () => {
    // Every legacy run predates the field. The safe reading is "no outbound writeback for a run
    // whose intake cannot be proven headless".
    expect(isHeadlessIntake(undefined)).toBe(false)
  })

  it('keeps a schedule fire OFF the headless path even though nobody is watching it', () => {
    // The one answer that looks wrong at a glance, and the reason the flag is not simply
    // "unattended": a cadence run works the schedule's REUSED block, whose linked ticket is
    // replaced on the next fire, so a question posted there loses its reply channel. What the
    // writeback needs is a stable place to hold a conversation, not merely an absent human.
    expect(isHeadlessIntake('schedule')).toBe(false)
    expect(isHeadlessIntake('tracker')).toBe(true)
  })
})
