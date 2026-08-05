import { describe, expect, it } from 'vitest'
import type { GateStepState, PipelineStep } from '@cat-factory/contracts'
import { unanswerableWaits } from './projection.js'

// What a run stopped on something this surface CANNOT answer reports about itself.
//
// The defect these cover is one of omission and was invisible by construction: a run held by
// `human-review` produced `decisions: []`, which is byte-for-byte what a run doing ordinary work
// produces, so an integration could not tell "a person must review the PR" from "nothing is
// happening" and its only recourse was to stop the run. Every case below is therefore about a
// wait being NAMED, and about the ones that must stay unnamed because nobody has to act on them.

const gate = (over: Partial<GateStepState> = {}): GateStepState => ({
  phase: 'checking',
  attempts: 0,
  maxAttempts: 3,
  ...over,
})

const step = (agentKind: string, over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind, state: 'working', progress: 0, ...over }) as PipelineStep

describe('unanswerableWaits', () => {
  it('names a live human-wait gate and says where the answer lives', () => {
    const [wait, ...rest] = unanswerableWaits(
      { steps: [step('coder', { state: 'done' }), step('human-review', { gate: gate() })] },
      null,
    )
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

  it('names a gate the DEPLOYMENT registered, without claiming to know if it ever ends', () => {
    const [wait] = unanswerableWaits({ steps: [step('legal-signoff', { gate: gate() })] }, null)
    expect(wait).toMatchObject({ reason: 'unclassified_gate', stepKind: 'legal-signoff' })
    expect(wait!.detail).toContain('registered itself')
  })

  it.each(['ci', 'conflicts', 'post-release-health', 'doc-quality'])(
    'stays silent about the bounded built-in gate %s',
    (kind) => {
      // A gate looping through its fixer is the gate doing its job. Listing it would read as a
      // demand for a human that nobody has to meet, which is the same misreport in the other
      // direction: a caller escalating a run that was going to resolve itself.
      expect(unanswerableWaits({ steps: [step(kind, { gate: gate() })] }, null)).toEqual([])
    },
  )

  it('ignores a gate step that already SETTLED', () => {
    // A finished gate keeps its state on the step, so "has gate state" alone would report every
    // CI gate a long run ever passed through, forever.
    expect(
      unanswerableWaits({ steps: [step('human-review', { gate: gate(), state: 'done' })] }, null),
    ).toEqual([])
  })

  it('names an interviewer registered with no controller wired', () => {
    const [wait] = unanswerableWaits(
      { steps: [step('coder', { state: 'done' }), step('domain-interviewer')] },
      'domain-interviewer',
    )
    expect(wait).toMatchObject({
      reason: 'unwired_interview_gate',
      stepKind: 'domain-interviewer',
      stepIndex: 1,
    })
  })

  it('reports every wait a run carries, not just the first', () => {
    // A pipeline may carry more than one, and collapsing them would hide whichever came second —
    // the caller would clear one wait and find the run still stopped for a reason nobody named.
    expect(
      unanswerableWaits(
        {
          steps: [step('human-review', { gate: gate() }), step('legal-signoff', { gate: gate() })],
        },
        null,
      ).map((w) => w.reason),
    ).toEqual(['human_wait_gate', 'unclassified_gate'])
  })

  it('is empty for a run that is simply working', () => {
    expect(unanswerableWaits({ steps: [step('coder'), step('tester')] }, null)).toEqual([])
  })
})
