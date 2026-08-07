import { BUILTIN_GATE_KINDS, HUMAN_WAIT_GATE_KINDS } from '@cat-factory/contracts'
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
  /**
   * Every built-in gate, with the `pollExhaustion` its definition actually declares.
   *
   * Built INSIDE each test rather than once in the describe body, which is not a style choice.
   * A describe body runs at COLLECTION time, before any mutant is activated, so a snapshot taken
   * there is computed from unmutated source and every assertion below reads the same frozen copy
   * however the declaration is rewritten. It made this guard invisible to mutation testing: the
   * whole of `pollExhaustion: 'rearm'` could be emptied and all four cases still passed.
   */
  const builtins = () =>
    gateRegistryWithBuiltins()
      .factories()
      .map(({ kind, factory }) => ({
        kind,
        pollExhaustion: factory(stubGateContext()).pollExhaustion,
      }))

  it('registers at least one built-in gate (the guard is not passing vacuously)', () => {
    expect(builtins().length).toBeGreaterThan(0)
  })

  it('names exactly the unbounded human-wait gates in HUMAN_WAIT_GATE_KINDS', () => {
    // `rearm` is the engine's marker for "there is no deadline here, a person is the gate": running
    // out of polls is not a verdict, so the step re-arms rather than passing or failing. That is
    // precisely a human park, and it is what admission must refuse a `write` key.
    const rearming = builtins()
      .filter((g) => g.pollExhaustion === 'rearm')
      .map((g) => g.kind)
    expect([...rearming].sort()).toEqual([...HUMAN_WAIT_GATE_KINDS].sort())
  })

  it('declares a pollExhaustion the engine actually understands, on every gate', () => {
    // The engine resolves this against three named dispositions and treats an unrecognised value
    // as the `fail` default, so a gate whose declaration was garbled does not fail loudly: the
    // watch gate starts reporting a spent poll budget as a regression, and the human-wait gate
    // starts killing runs a reviewer had not got to. Only the two constants above are checked
    // elsewhere, and both are blind to a value outside the vocabulary.
    for (const { kind, pollExhaustion } of builtins()) {
      expect([undefined, 'pass', 'fail', 'rearm'], kind).toContain(pollExhaustion)
    }
  })

  it('names exactly the shipped gates in BUILTIN_GATE_KINDS', () => {
    // The other constant the same two packages must agree about, and it is read for its NEGATIVE:
    // a gate step whose kind is absent was registered by the DEPLOYMENT, which is what the public
    // decision surface reports it as when a run stops there with nothing to answer. A built-in
    // missing here would be reported to an operator as their own registration, sending them to
    // look for a gate they never wrote.
    expect([...BUILTIN_GATE_KINDS].sort()).toEqual(
      builtins()
        .map((g) => g.kind)
        .sort(),
    )
  })

  it('keeps every bounded gate OUT of the set', () => {
    // The other direction, stated separately because it fails differently: a gate wrongly listed
    // here makes admission refuse a `write` key that should have been allowed, which reads to an
    // operator as the scope ladder being broken rather than as a classification bug.
    for (const { kind, pollExhaustion } of builtins()) {
      if (pollExhaustion !== 'rearm') expect(HUMAN_WAIT_GATE_KINDS.has(kind)).toBe(false)
    }
  })
})
