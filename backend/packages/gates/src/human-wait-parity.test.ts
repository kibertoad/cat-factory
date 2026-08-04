import { HUMAN_WAIT_GATE_KINDS } from '@cat-factory/contracts'
import { stubGateContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { gateRegistryWithBuiltins } from './index.js'

// Drift guard for the ONE fact two packages that cannot see each other both depend on: which gate
// kinds park the run on a human.
//
// `@cat-factory/gates` owns the truth, as each gate's `pollExhaustion` declaration. The public API's
// admission rule (`@cat-factory/server`'s publicApiAdmission) needs the same answer at HTTP request
// time, where invoking a gate factory to read it is not an option: a factory closes over engine
// seams, and building one with a fake context to interrogate a static declaration would be a
// shortcut, not a design. So the answer is a shared constant in `@cat-factory/contracts`, and this
// test is what keeps the constant honest.
//
// The check derives its expectation from the REGISTRY rather than a hand-written list, so a gate
// added to `registerBuiltinGates` is covered the moment it exists. A new unbounded-wait gate
// therefore cannot ship without being classified: it fails here until it is named in
// `HUMAN_WAIT_GATE_KINDS`, which is the whole point. Getting this wrong is silent in production,
// because the symptom is a `write`-scope key successfully starting a pipeline that then parks
// forever on a surface the public decision API cannot answer.
describe('human-wait gate parity', () => {
  /** Every built-in gate, with the `pollExhaustion` its definition actually declares. */
  const builtins = gateRegistryWithBuiltins()
    .factories()
    .map(({ kind, factory }) => ({
      kind,
      pollExhaustion: factory(stubGateContext()).pollExhaustion,
    }))

  it('registers at least one built-in gate (the guard is not passing vacuously)', () => {
    expect(builtins.length).toBeGreaterThan(0)
  })

  it('names exactly the unbounded human-wait gates in HUMAN_WAIT_GATE_KINDS', () => {
    // `rearm` is the engine's marker for "there is no deadline here, a person is the gate": running
    // out of polls is not a verdict, so the step re-arms rather than passing or failing. That is
    // precisely a human park, and it is what admission must refuse a `write` key.
    const rearming = builtins.filter((g) => g.pollExhaustion === 'rearm').map((g) => g.kind)
    expect([...rearming].sort()).toEqual([...HUMAN_WAIT_GATE_KINDS].sort())
  })

  it('keeps every bounded gate OUT of the set', () => {
    // The other direction, stated separately because it fails differently: a gate wrongly listed
    // here makes admission refuse a `write` key that should have been allowed, which reads to an
    // operator as the scope ladder being broken rather than as a classification bug.
    for (const { kind, pollExhaustion } of builtins) {
      if (pollExhaustion !== 'rearm') expect(HUMAN_WAIT_GATE_KINDS.has(kind)).toBe(false)
    }
  })
})
