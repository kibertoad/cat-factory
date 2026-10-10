import { describe, expect, it } from 'vitest'
import { viewRunIdentity } from './runIdentityVisibility.js'

// The rule stands between one person's key and the roster of everyone else's, so what is pinned
// here is the WHOLE truth table: three answers over the pairs of (what the run names, what the
// reading key is). The interesting half is that two of the three produce a null identity for
// opposite reasons, which is the distinction the flag exists to carry.

describe('viewRunIdentity', () => {
  it('shows an identity-less key every run, which is the mapping the feature is for', () => {
    // The provisioner (and any key minted in the app by a member who can already read the board).
    expect(viewRunIdentity('ada@example.com', null)).toEqual({
      externalIdentity: 'ada@example.com',
      externalIdentityWithheld: false,
    })
  })

  it('shows an identity-bearing key its own runs', () => {
    expect(viewRunIdentity('ada@example.com', 'ada@example.com')).toEqual({
      externalIdentity: 'ada@example.com',
      externalIdentityWithheld: false,
    })
  })

  it('withholds another identity from an identity-bearing key, and SAYS it withheld', () => {
    // The leak this exists to close: one key per person means every key would otherwise read
    // back every other person's identity, which is routinely their email.
    expect(viewRunIdentity('bob@example.com', 'ada@example.com')).toEqual({
      externalIdentity: null,
      externalIdentityWithheld: true,
    })
  })

  it('never reports a run that names nobody as a withheld one', () => {
    // The distinction the flag carries. An app-started run, a schedule, or a key minted with no
    // identity genuinely names nobody; blanking a withheld run to the same shape would report a
    // mapping the platform is holding as one it never had.
    for (const reader of [null, 'ada@example.com']) {
      for (const pinned of [null, undefined]) {
        expect(viewRunIdentity(pinned, reader)).toEqual({
          externalIdentity: null,
          externalIdentityWithheld: false,
        })
      }
    }
  })

  it('compares the stored bytes exactly, never a folded or trimmed form', () => {
    // The value is opaque at every other boundary: it is stored verbatim and never parsed. A
    // fold here would invent a semantics the mint side does not share, and it would WIDEN the
    // rule, letting two identities a provisioner considers distinct read each other's runs.
    expect(viewRunIdentity('Ada@Example.com', 'ada@example.com').externalIdentityWithheld).toBe(
      true,
    )
    expect(viewRunIdentity('ada@example.com ', 'ada@example.com').externalIdentityWithheld).toBe(
      true,
    )
  })
})
