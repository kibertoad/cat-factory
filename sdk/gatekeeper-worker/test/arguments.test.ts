// Argument validation, against the generated table rather than against a transcribed shape.
//
// The claims worth making here are RELATIONS over a table this test does not own: what an
// operation declares comes from `@cat-factory/gatekeeper-bindings`, so a spec pinning "tasks_create
// takes serviceId and body" would be a second copy of a generated fact, and would fail on the day
// the surface changes without anything being wrong. What is asserted instead is that the check and
// the table agree, and the one thing neither can state alone: that every arg bag this package
// itself builds passes it.

import { describe, expect, it } from 'vitest'
import { bindingByName, GATEKEEPER_BINDINGS } from '@cat-factory/gatekeeper-bindings'
import { checkedArguments, declaredArguments } from '../src/index.js'
import {
  ANSWERABLE_DECISION_KINDS,
  answererFor,
  type DecisionCall,
  type DecisionVerb,
} from '../src/policy/index.js'

/** A bag naming every argument the binding declares, so only the check under test can refuse it. */
function completeBag(name: string): Record<string, unknown> {
  const binding = bindingByName(name)
  if (binding === undefined) throw new Error(`the table carries no '${name}'`)
  const bag: Record<string, unknown> = {}
  for (const param of binding.pathParams) bag[param] = 'id_1'
  for (const param of binding.queryParams) if (param.required) bag[param.name] = 'value'
  if (binding.hasBody) bag.body = {}
  return bag
}

describe('checkedArguments', () => {
  it('refuses an argument the operation does not declare, rather than dropping it', () => {
    const binding = bindingByName('tasks_get')!

    // The failure this exists for: forwarded silently, an unrecognised filter is an unfiltered
    // answer shaped exactly like a filtered one.
    expect(() => checkedArguments(binding, { ...completeBag('tasks_get'), limit: 5 })).toThrow(
      /does not take 'limit'/,
    )
  })

  it('names what the operation does take, so a near-miss spelling is one read away', () => {
    const binding = bindingByName('tasks_get')!

    expect(() => checkedArguments(binding, { taskID: 'blk_1' })).toThrow(
      new RegExp(
        `It takes ${declaredArguments(binding)
          .map((name) => `'${name}'`)
          .join(', ')}`,
      ),
    )
  })

  it('refuses a missing path parameter as part of the route, not as a validation nicety', () => {
    const binding = bindingByName('tasks_get')!

    expect(() => checkedArguments(binding, {})).toThrow(/part of the route/)
  })

  it('refuses a missing REQUIRED query parameter, and admits an omitted optional one', () => {
    const spend = bindingByName('usage_spend')!
    const required = spend.queryParams.filter((param) => param.required).map((param) => param.name)
    // A relation over the table rather than a pinned name: what this test is about is that
    // requiredness is honoured, and which parameters are required is the deployment's to change.
    expect(required.length).toBeGreaterThan(0)

    expect(() => checkedArguments(spend, {})).toThrow(new RegExp(`needs '${required[0]}'`))
    expect(() => checkedArguments(spend, completeBag('usage_spend'))).not.toThrow()
  })

  it('treats an undefined value as absent, the way a bag built from optional fields arrives', () => {
    const binding = bindingByName('tasks_get')!

    expect(() =>
      checkedArguments(binding, { ...completeBag('tasks_get'), body: undefined }),
    ).not.toThrow()
  })
})

describe('declaredArguments', () => {
  it('covers every operation the table carries without throwing on any of them', () => {
    for (const binding of GATEKEEPER_BINDINGS) {
      expect(() => checkedArguments(binding, completeBag(binding.name))).not.toThrow()
    }
  })
})

/** A decision carrying every id an answerer reads, so a verb's own refusals do not stand in. */
const SYNTHETIC_DECISION = {
  approvalId: 'apr_1',
  decisionId: 'dec_1',
  stage: 'diverge',
}

/** An answer naming each field given, with a value inside its choices where it has any. */
function inputFor(fields: readonly { name: string; choices?: readonly string[] }[]) {
  return Object.fromEntries(fields.map((field) => [field.name, field.choices?.[0] ?? 'text']))
}

/**
 * One answer a verb accepts, found rather than assumed.
 *
 * A verb's fields are not a bag to fill in: some are exclusive (`forkId` xor `custom`), so an
 * answer naming every field is refused by the verb itself before the check under test ever sees
 * it. Trying the required fields alone and then with one optional at a time finds an accepted
 * shape for every verb the answerer table carries, and fails LOUDLY where none exists rather than
 * skipping the verb, which would leave it uncovered while the suite stayed green.
 */
function someAcceptedCall(kind: string, verb: DecisionVerb): DecisionCall {
  const required = verb.fields.filter((field) => field.required)
  const optional = verb.fields.filter((field) => !field.required)
  const decision = { kind, ...SYNTHETIC_DECISION }
  for (const fields of [required, ...optional.map((field) => [...required, field])]) {
    try {
      return verb.call(decision, inputFor(fields))
    } catch {
      continue
    }
  }
  throw new Error(`no answer this suite composes is accepted by ${kind}/${verb.action}`)
}

describe('the answer path builds bags this check admits', () => {
  it('sends only declared arguments, for every verb of every park it can answer', () => {
    // The assertion the validation makes possible, and the reason it is worth having: a verb
    // naming an argument its binding does not declare used to be a field silently dropped on the
    // way to the platform, and the platform's own 422 would name a field the caller did supply.
    // The bag is the one `answerCard` forwards, which is the run id plus the verb's own.
    for (const kind of ANSWERABLE_DECISION_KINDS) {
      const answerer = answererFor(kind)
      expect(answerer, `no answerer for '${kind}'`).toBeDefined()
      for (const verb of answerer!.verbs) {
        const binding = bindingByName(verb.binding)
        expect(
          binding,
          `${kind}/${verb.action} names an operation the table does not carry`,
        ).toBeDefined()
        const call = someAcceptedCall(kind, verb)
        expect(() => checkedArguments(binding!, { runId: 'run_1', ...call.args })).not.toThrow()
      }
    }
  })
})
