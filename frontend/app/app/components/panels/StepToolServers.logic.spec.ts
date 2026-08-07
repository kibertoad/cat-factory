import { describe, it, expect } from 'vitest'
import {
  KNOWN_REASONS,
  REASON_KEY,
  REMEDY_KEY,
  reasonText,
  remedyText,
} from './StepToolServers.logic'
import type { ToolServerUnavailableReason } from '~/types/toolServers'

/**
 * A dropped tool server is the whole point of this surface: until it existed, a run that quietly
 * went without its issue tracker was stated only in the agent's own prompt and one backend warn
 * line. These pin the two ways that could regress: a reason with no copy, and a reason this build
 * does not know rendering as nothing at all.
 */
describe('tool-server unavailability reasons', () => {
  it('gives every reason in the wire vocabulary its own copy', () => {
    // Derived from the schema the backend decides against, not from a list retyped here: a member
    // added on the backend then fails THIS assertion instead of shipping as a blank chip.
    expect(Object.keys(REASON_KEY).sort()).toEqual([...KNOWN_REASONS].sort())
  })

  it('never points two reasons at one line', () => {
    // Each member names a different fix (a variable to set, a declaration to change, a person to
    // press Connect), so two sharing copy would send an operator to the wrong place.
    const keys = Object.values(REASON_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('renders a retired reason as unknown, naming the raw code', () => {
    // The vocabulary is persisted on a run, so a step recorded under a member since retired reads
    // back with that member. Dropping it would report a withheld tool as one never declared.
    expect(render('legacy_reason')).toEqual([
      {
        key: 'panels.stepDetail.toolServers.reason.unknown',
        params: { reason: 'legacy_reason' },
      },
    ])
  })

  it('takes the same path for a reason that names an Object.prototype member', () => {
    // The mapping is an ordinary object literal, so `REASON_KEY['constructor']` reads back a
    // truthy inherited function. A truthiness check on the lookup would hand THAT to `t` as a
    // translation key, taking the retired-member path away from the one input shape most likely
    // to reach it from a hand-edited or corrupted row.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(render(inherited)).toEqual([
        {
          key: 'panels.stepDetail.toolServers.reason.unknown',
          params: { reason: inherited },
        },
      ])
    }
  })
})

/**
 * The remedy is the half an operator acts on. A diagnosis with no next step is where this surface
 * started: the reason was already stated to the AGENT in its prompt, and stating it to a person
 * changes nothing unless it also names what to change.
 */
describe('tool-server unavailability remedies', () => {
  it('gives every reason in the wire vocabulary a remedy of its own', () => {
    expect(Object.keys(REMEDY_KEY).sort()).toEqual([...KNOWN_REASONS].sort())
  })

  it('never points two reasons at one remedy', () => {
    // The vocabulary exists BECAUSE each member needs a different fix, so two members sharing a
    // remedy line means either the copy is wrong or the split was.
    const keys = Object.values(REMEDY_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never reuses a reason line as a remedy', () => {
    // The two are rendered together. A remedy pointing at the reason's own key would render the
    // diagnosis twice and read as advice.
    const reasons = new Set(Object.values(REASON_KEY))
    for (const key of Object.values(REMEDY_KEY)) expect(reasons.has(key)).toBe(false)
  })

  it('offers no remedy for a retired reason, rather than guessing one', () => {
    // The build knows the code was recorded and not what it meant. Any remedy here would name a
    // surface picked from a member the operator may never have hit, and the reason line already
    // states the raw code, which is the whole of what is known.
    for (const reason of ['legacy_reason', 'constructor', '__proto__']) {
      expect(remedyText(reason as ToolServerUnavailableReason, (key) => key)).toBeNull()
    }
  })
})

/** Every `t` call `reasonText` made, so the assertion is about the key it CHOSE, not the copy. */
function render(reason: string): { key: string; params?: Record<string, unknown> }[] {
  const seen: { key: string; params?: Record<string, unknown> }[] = []
  reasonText(reason as ToolServerUnavailableReason, (key, params) => {
    seen.push({ key, ...(params ? { params } : {}) })
    return key
  })
  return seen
}
