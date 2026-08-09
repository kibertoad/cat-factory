import { describe, expect, it } from 'vitest'
import type { ExecutionStatus, GateStepState, PipelineStep } from '@cat-factory/contracts'
import type { GateDefinition, GatePollExhaustion } from '@cat-factory/kernel'
import { defaultGateRegistry } from '@cat-factory/kernel'
import type { UnwiredInterviewGate } from './projection.js'
import { unanswerableWaits } from './projection.js'

// What a run stopped on something this surface CANNOT answer reports about itself.
//
// The defect these cover is one of omission and was invisible by construction: a run held by
// `human-review` produced `decisions: []`, which is byte-for-byte what a run doing ordinary work
// produces, so an integration could not tell "a person must review the PR" from "nothing is
// happening" and its only recourse was to stop the run. Every case below is therefore about a
// wait being NAMED, and about the ones that must stay unnamed because nobody has to act on them.
//
// The last group is the same misreport pointed the other way. A named wait is a DEMAND on a
// person, so naming one nobody has to meet — because the run is over, or because the answer is in
// the very list this sits beside — spends exactly the escalation the field exists to earn.

const gate = (over: Partial<GateStepState> = {}): GateStepState => ({
  phase: 'checking',
  attempts: 0,
  maxAttempts: 3,
  ...over,
})

const step = (agentKind: string, over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind, state: 'working', progress: 0, ...over }) as PipelineStep

/**
 * The gate registrations these cases reason against: the shipped suite's own declarations, plus a
 * deployment gate that declares itself a human wait.
 *
 * The classification is read off the REGISTRATION, so `acme-legal-hold` is named as a human wait
 * exactly like `human-review` is, which is the change these cases pin. A kind absent from this map
 * entirely (`legal-signoff` below) is the remaining `unclassified_gate` case: nothing registered
 * it here, so nothing can say whether its poll ever ends.
 */
const GATE_DECLARATIONS: Record<string, GatePollExhaustion> = {
  'human-review': 'rearm',
  'acme-legal-hold': 'rearm',
  ci: 'fail',
  conflicts: 'fail',
  'post-release-health': 'pass',
  'doc-quality': 'fail',
}

const gates = (() => {
  const registry = defaultGateRegistry()
  for (const [kind, pollExhaustion] of Object.entries(GATE_DECLARATIONS)) {
    registry.register(kind, () => ({ kind }) as unknown as GateDefinition, { pollExhaustion })
  }
  return registry
})()

/**
 * Ask the question the projection asks. Both extra inputs default to "nothing else is going on"
 * (a live run, no unwired interviewer, no step answerable through `decisions[]`), so each case
 * below states only the fact it is about.
 */
function waitsFor(
  steps: PipelineStep[],
  over: {
    status?: ExecutionStatus
    unwiredGate?: UnwiredInterviewGate | null
    answered?: ReadonlySet<number>
  } = {},
) {
  return unanswerableWaits(
    { status: over.status ?? 'blocked', steps },
    gates,
    over.unwiredGate ?? null,
    over.answered ?? new Set(),
  )
}

describe('unanswerableWaits', () => {
  it('names a live human-wait gate and says where the answer lives', () => {
    const [wait, ...rest] = waitsFor([
      step('coder', { state: 'done' }),
      step('human-review', { gate: gate() }),
    ])
    expect(rest).toEqual([])
    expect(wait).toMatchObject({
      reason: 'human_wait_gate',
      stepKind: 'human-review',
      stepIndex: 1,
    })
    // The detail exists to turn "something is wrong" into an action, so it must name both the
    // real answer and the exit — neither of which is a call on this surface.
    expect(wait!.detail).toContain('approves the pull request')
    expect(wait!.detail).toContain('POST /api/v1/tasks/:taskId/stop')
  })

  it("names a DEPLOYMENT's own wait gate as a human wait, not as an unknown", () => {
    // The gap this closed. A gate's `pollExhaustion` is declared at registration, so a gate a
    // deployment registered itself is classified by exactly the rule `human-review` goes through.
    // Before, only the SHIPPED wait gates were nameable and everything else was reported as
    // unclassifiable, which told an operator to go and find out something the platform knew.
    const [wait, ...rest] = waitsFor([step('acme-legal-hold', { gate: gate() })])
    expect(rest).toEqual([])
    expect(wait).toMatchObject({ reason: 'human_wait_gate', stepKind: 'acme-legal-hold' })
  })

  it('reports a gate kind NOTHING registers here as unclassified', () => {
    // What survives of the old reason, with a narrower meaning: a run outlives a registration (a
    // retired gate, or a node one build behind), and a kind this process has no registration for is
    // the one case where "cannot say whether that poll ever ends" is still the honest answer.
    const [wait] = waitsFor([step('legal-signoff', { gate: gate() })])
    expect(wait).toMatchObject({ reason: 'unclassified_gate', stepKind: 'legal-signoff' })
    expect(wait!.detail).toContain('no registration')
  })

  it.each(['ci', 'conflicts', 'post-release-health', 'doc-quality'])(
    'stays silent about the bounded built-in gate %s',
    (kind) => {
      // A gate looping through its fixer is the gate doing its job. Listing it would read as a
      // demand for a human that nobody has to meet, which is the same misreport in the other
      // direction: a caller escalating a run that was going to resolve itself.
      expect(waitsFor([step(kind, { gate: gate() })])).toEqual([])
    },
  )

  it('ignores a gate step that already SETTLED', () => {
    // A finished gate keeps its state on the step, so "has gate state" alone would report every
    // CI gate a long run ever passed through, forever.
    expect(waitsFor([step('human-review', { gate: gate(), state: 'done' })])).toEqual([])
  })

  it('names an interviewer registered with no controller wired', () => {
    const [wait] = waitsFor([step('coder', { state: 'done' }), step('domain-interviewer')], {
      unwiredGate: { stepKind: 'domain-interviewer', stepIndex: 1 },
    })
    expect(wait).toMatchObject({
      reason: 'unwired_interview_gate',
      stepKind: 'domain-interviewer',
      stepIndex: 1,
    })
  })

  it('takes the interviewer index from the PARKED step, not the first of its kind', () => {
    // A chain can carry the same interviewer twice (a second pass after a rework). `stepIndex`
    // exists to be lined up against `publicRun.steps`, so reporting the earlier, already-finished
    // step's position would point a caller at a step that is holding nothing. The index comes from
    // the resolver that found the parked step rather than a re-search by kind here.
    const [wait] = waitsFor(
      [
        step('domain-interviewer', { state: 'done' }),
        step('coder', { state: 'done' }),
        step('domain-interviewer'),
      ],
      { unwiredGate: { stepKind: 'domain-interviewer', stepIndex: 2 } },
    )
    expect(wait).toMatchObject({ reason: 'unwired_interview_gate', stepIndex: 2 })
  })

  it('reports every wait a run carries, not just the first', () => {
    // A pipeline may carry more than one, and collapsing them would hide whichever came second —
    // the caller would clear one wait and find the run still stopped for a reason nobody named.
    expect(
      waitsFor([
        step('human-review', { gate: gate() }),
        step('legal-signoff', { gate: gate() }),
      ]).map((w) => w.reason),
    ).toEqual(['human_wait_gate', 'unclassified_gate'])
  })

  it('is empty for a run that is simply working', () => {
    expect(waitsFor([step('coder'), step('tester')], { status: 'running' })).toEqual([])
  })

  it.each(['done', 'failed'] as const)('names nothing on a run that has ENDED (%s)', (status) => {
    // `failRun` records the failure and stops; it never walks the chain settling steps, so a
    // stopped or failed run keeps its gate step exactly as it stood. Read off the steps alone,
    // this told someone who had just cancelled a run that a reviewer still had to approve its
    // pull request — and offered them the stop call they had already made.
    expect(
      waitsFor([step('human-review', { gate: gate() }), step('domain-interviewer')], {
        status,
        unwiredGate: { stepKind: 'domain-interviewer', stepIndex: 1 },
      }),
    ).toEqual([])
  })

  it('is silent about a gate whose park this response ALREADY answers', () => {
    // A deployment gate that spends its attempt budget hands off to `onExhausted`, which raises an
    // ordinary step approval: an answerable `decisions[]` entry. The gate state stays on the step,
    // so without the answered set the same payload both offers the answer and says the answer
    // lives somewhere this surface cannot reach.
    expect(
      waitsFor([step('legal-signoff', { gate: gate(), state: 'waiting_decision' })], {
        answered: new Set([0]),
      }),
    ).toEqual([])
  })

  it('still names an unanswered wait beside an answered one', () => {
    // The exclusion is per STEP, not a switch that silences the whole report: a run can carry an
    // exhausted gate the caller can answer and a human-review gate they cannot.
    expect(
      waitsFor(
        [
          step('legal-signoff', { gate: gate(), state: 'waiting_decision' }),
          step('human-review', { gate: gate() }),
        ],
        { answered: new Set([0]) },
      ).map((w) => ({ reason: w.reason, stepIndex: w.stepIndex })),
    ).toEqual([{ reason: 'human_wait_gate', stepIndex: 1 }])
  })
})
