import {
  defaultGateRegistry,
  HUMAN_REVIEW_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { gateRegistryWithBuiltins, registerBuiltinGates } from './index.js'

// What each shipped gate declares about a spent poll budget, asserted at the REGISTRATION, which is
// where that declaration now lives.
//
// It used to live on the object each gate's factory builds, which made it unreadable to the two
// callers that most need it: pipeline save and public-API admission hold no engine context, and
// standing a fake one up per HTTP request to interrogate a static declaration is a shortcut rather
// than a design. So the answer was mirrored into a hand-kept constant in `@cat-factory/contracts`
// naming the shipped human-wait gates, and this file was the drift guard keeping the copy honest.
//
// The copy is gone: `GateRegistry.pollExhaustion(kind)` answers from the registration, so the
// shipped gates and a deployment's own go through one rule and there is nothing left to drift.
// What remains worth pinning here is the half this package owns, which of ITS gates waits on a
// person, because the consequence of getting it wrong is silent in production: a `write`-scope key
// successfully starts a pipeline that then parks forever on a surface the public decision API
// cannot answer.
describe('built-in gate poll-exhaustion declarations', () => {
  it('declares the human-review gate an unbounded human wait', () => {
    // `rearm` is the engine's marker for "there is no deadline here, a person is the gate":
    // running out of polls is not a verdict, so the step re-arms rather than passing or failing.
    // That is precisely a human park, and it is what admission must refuse a `write` key.
    expect(gateRegistryWithBuiltins().pollExhaustion(HUMAN_REVIEW_AGENT_KIND)).toBe('rearm')
  })

  it('declares the release-watch gate a PASS, so a spent budget is not a false regression', () => {
    // A time-windowed watch whose window outlasted the driver's poll budget saw no regression.
    // Reading that as a timeout failure would fail runs whose release was healthy.
    expect(gateRegistryWithBuiltins().pollExhaustion(POST_RELEASE_HEALTH_AGENT_KIND)).toBe('pass')
  })

  it('leaves every other shipped gate bounded', () => {
    // The other direction, stated separately because it fails differently: a gate wrongly declared
    // `rearm` makes admission refuse a `write` key a start it should have been allowed, which reads
    // to an operator as the scope ladder being broken rather than as a classification bug.
    //
    // Derived from the registry rather than a hand-written list, so a gate added to
    // `registerBuiltinGates` is covered the moment it exists and has to be classified deliberately.
    const registry = gateRegistryWithBuiltins()
    const waiting = registry
      .factories()
      .map(({ kind }) => kind)
      .filter((kind) => registry.pollExhaustion(kind) === 'rearm')
    expect(waiting).toEqual([HUMAN_REVIEW_AGENT_KIND])
  })

  it('registers at least one gate (the assertions above are not passing vacuously)', () => {
    expect(gateRegistryWithBuiltins().factories().length).toBeGreaterThan(0)
  })

  it('installs the same declarations into an injected registry', () => {
    // `gateRegistryWithBuiltins()` is the convenience wrapper; a composition root that was handed a
    // registry calls `registerBuiltinGates` on it instead, and a declaration that rode only the
    // wrapper would be missing on exactly the deployments that register gates of their own.
    const injected = defaultGateRegistry()
    registerBuiltinGates(injected)
    expect(injected.pollExhaustion(HUMAN_REVIEW_AGENT_KIND)).toBe('rearm')
  })
})
