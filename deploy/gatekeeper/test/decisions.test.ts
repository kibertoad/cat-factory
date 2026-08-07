// The answerer table, checked against the operation table it forwards through.
//
// Two classes of assertion, and the split is deliberate. The RELATIONS (every verb names a real
// binding; every binding a verb names is inside the scope the shipped `approver` tier mints) are
// derived from `@cat-factory/gatekeeper-bindings` rather than pinned to a list, so they keep
// holding as the surface grows. The BEHAVIOURS are the refusals: a verb that silently defaulted a
// missing field is how an integration posts a body the platform rejects with a 422 naming a field
// the caller never chose.

import { bindingByName, bindingsWithinScope } from '@cat-factory/gatekeeper-bindings'
import { describe, expect, it } from 'vitest'
import {
  ANSWERABLE_DECISION_KINDS,
  answererFor,
  DECISION_BINDINGS,
  DECISION_KEY_SCOPE,
  type DecisionAnswerer,
} from '../src/decisions'
import { GatekeeperError } from '../src/errors'

function answerer(kind: string): DecisionAnswerer {
  const found = answererFor(kind)
  if (found === undefined) throw new Error(`no answerer for '${kind}'`)
  return found
}

const everyVerb = ANSWERABLE_DECISION_KINDS.flatMap((kind) =>
  answerer(kind).verbs.map((verb) => ({ kind, verb })),
)

describe('the answerer table against the live operation table', () => {
  // The compiler already refuses a table missing a kind (`satisfies Record<ParkedDecisionKind, …>`),
  // so what is worth asserting at runtime is the OTHER direction of the same fact: the exported
  // list is the table's own keys, which is what a policy author and `approvals_inspect` read.
  it('covers every kind the surface can park on', () => {
    expect(ANSWERABLE_DECISION_KINDS.length).toBeGreaterThan(0)
    for (const kind of ANSWERABLE_DECISION_KINDS) {
      expect(answererFor(kind)?.verbs.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('names only operations this deployment actually serves', () => {
    for (const { kind, verb } of everyVerb) {
      expect(bindingByName(verb.binding), `${kind}/${verb.action} → ${verb.binding}`).toBeDefined()
    }
  })

  // The relation the shipped `approver` tier depends on: every operation an answer forwards
  // through is inside the scope that tier mints. A floor the platform ever RAISED would fail here
  // rather than becoming a granted method that 403s on every call.
  it('keeps every decision binding within the scope a decide key mints', () => {
    const reachable = new Set(bindingsWithinScope(DECISION_KEY_SCOPE).map((b) => b.name))
    expect(DECISION_BINDINGS.filter((name) => !reachable.has(name))).toEqual([])
  })

  it('publishes the read that finds the park alongside the verbs that settle it', () => {
    expect(DECISION_BINDINGS).toContain('decisions_list')
    for (const { verb } of everyVerb) expect(DECISION_BINDINGS).toContain(verb.binding)
  })

  it('lists each binding once, so a policy built from it grants nothing twice', () => {
    expect(new Set(DECISION_BINDINGS).size).toBe(DECISION_BINDINGS.length)
  })
})

describe('what a verb refuses rather than defaults', () => {
  // The finding this replaced: `request-changes` forwarded `feedback: ''`, which the contract
  // rejects with `minLength(1)` after trim. The caller got an opaque 422 from a field it never set.
  it('refuses request-changes with no feedback, naming the field', () => {
    const verb = answerer('approval-gate').verbs.find((v) => v.action === 'request-changes')!
    expect(() => verb.call({ kind: 'approval-gate', approvalId: 'ap_1' }, {})).toThrow(
      GatekeeperError,
    )
    expect(() =>
      verb.call({ kind: 'approval-gate', approvalId: 'ap_1' }, { feedback: '  ' }),
    ).toThrow(/needs 'feedback'/)
  })

  // And the mirror image: a gate at its rework cap used to default `choice` to `proceed`, which
  // silently picks one of three settlements: the one that ships work nobody looked at.
  it('refuses resolve-exceeded with no choice rather than picking one', () => {
    const verb = answerer('approval-gate').verbs.find((v) => v.action === 'resolve-exceeded')!
    expect(() => verb.call({ kind: 'approval-gate', approvalId: 'ap_1' }, {})).toThrow(
      /'extra-round', 'proceed', 'stop-reset'/,
    )
  })

  it('refuses a choice outside the closed set', () => {
    const verb = answerer('judge').verbs.find((v) => v.action === 'resolve')!
    expect(() => verb.call({ kind: 'judge' }, { choice: 'merge-it' })).toThrow(/needs 'choice'/)
  })

  // The platform enforces the same xor and answers 422. Refusing here says which two fields.
  it('refuses a fork choice that names both or neither of forkId and custom', () => {
    const verb = answerer('fork').verbs.find((v) => v.action === 'choose')!
    expect(() => verb.call({ kind: 'fork' }, {})).toThrow(/exactly one/)
    expect(() => verb.call({ kind: 'fork' }, { forkId: 'fk_1', custom: 'mine' })).toThrow(
      /exactly one/,
    )
    expect(verb.call({ kind: 'fork' }, { forkId: 'fk_1' })).toMatchObject({
      binding: 'decisions_choose_fork',
      args: { body: { forkId: 'fk_1' } },
    })
  })

  // An optional field that is absent must stay absent. Sending `{ proposal: '' }` would REPLACE
  // the agent's text with nothing, which is the opposite of "approve as written".
  it('omits an absent optional field rather than sending it empty', () => {
    const verb = answerer('approval-gate').verbs.find((v) => v.action === 'approve')!
    expect(verb.call({ kind: 'approval-gate', approvalId: 'ap_1' }, {}).args.body).toEqual({})
  })
})

describe('what a verb reads off the live decision', () => {
  it('addresses the approval by the id the platform arbitrates on', () => {
    const verb = answerer('approval-gate').verbs.find((v) => v.action === 'approve')!
    expect(verb.call({ kind: 'approval-gate', approvalId: 'ap_7' }, {}).args).toMatchObject({
      approvalId: 'ap_7',
    })
  })

  // A block can hold a `requirements` and an `architecture` session at once and every brainstorm
  // route takes the stage, so answering without it would settle whichever the platform reached
  // first. It comes off the decision, never off the caller.
  it('carries the brainstorm stage from the decision onto every verb', () => {
    for (const verb of answerer('brainstorm').verbs) {
      const call = verb.call(
        { kind: 'brainstorm', stage: 'architecture' },
        {
          itemId: 'ri_1',
          reply: 'yes',
          status: 'dismissed',
          choice: 'proceed',
        },
      )
      expect(call.args.stage, verb.action).toBe('architecture')
    }
  })

  // A platform-side shape this package cannot address is a stated refusal, not a call with
  // `undefined` spliced into the path.
  it('refuses a decision missing the id every answer to it addresses', () => {
    const verb = answerer('agent-decision').verbs[0]!
    expect(() => verb.call({ kind: 'agent-decision' }, { choice: 'the left one' })).toThrow(
      /carries no 'decisionId'/,
    )
  })
})

describe('when a park is holding the run', () => {
  it('treats a settled approval gate as not pending', () => {
    const { pending } = answerer('approval-gate')
    expect(pending({ kind: 'approval-gate', status: 'pending' })).toBe(true)
    expect(pending({ kind: 'approval-gate', status: 'approved' })).toBe(false)
    expect(pending({ kind: 'approval-gate' })).toBe(false)
  })

  it('treats an iterative review as pending only while it waits on a person', () => {
    const { pending } = answerer('requirements-review')
    expect(pending({ kind: 'requirements-review', status: 'ready' })).toBe(true)
    expect(pending({ kind: 'requirements-review', status: 'exceeded' })).toBe(true)
    expect(pending({ kind: 'requirements-review', status: 'incorporating' })).toBe(false)
    expect(pending({ kind: 'requirements-review', status: 'incorporated' })).toBe(false)
  })

  // Follow-ups accrue while the step still runs, so what holds them is a `pending` ITEM rather
  // than the run's status. A predicate keyed on the run would miss every early triage.
  it('treats follow-ups as pending while any item is undecided', () => {
    const { pending } = answerer('follow-ups')
    expect(pending({ kind: 'follow-ups', items: [{ status: 'pending' }] })).toBe(true)
    expect(pending({ kind: 'follow-ups', items: [{ status: 'filed' }] })).toBe(false)
    expect(pending({ kind: 'follow-ups', items: [] })).toBe(false)
    expect(pending({ kind: 'follow-ups' })).toBe(false)
  })
})
