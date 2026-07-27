import { describe, expect, it } from 'vitest'
import { activeJudgeStepIndex, type JudgeStepState } from './judge.js'

type Step = { agentKind: string; judge?: JudgeStepState | null }

const judged = (agentKind: string, status: JudgeStepState['status']): Step => ({
  agentKind,
  judge: {
    status,
    rubricName: agentKind,
    rubricOverridden: false,
    bounces: 0,
    maxBounces: 1,
    rounds: [],
  },
})

describe('activeJudgeStepIndex', () => {
  it('returns -1 when no step carries judge state', () => {
    const steps: Step[] = [{ agentKind: 'coder' }, { agentKind: 'ci' }]
    expect(activeJudgeStepIndex(steps, 1)).toBe(-1)
  })

  it('prefers a PARKED judge over the step the cursor is on', () => {
    // The whole point of the shared precedence: a park is definitionally the judge a human (or
    // a headless caller) is answering, so it wins even when the run's cursor has moved past it.
    const steps: Step[] = [
      judged('scope-adherence', 'awaiting_decision'),
      judged('house-standards', 'evaluating'),
    ]
    expect(steps[activeJudgeStepIndex(steps, 1)]?.agentKind).toBe('scope-adherence')
  })

  it('falls back to the current step when nothing is parked', () => {
    const steps: Step[] = [
      judged('scope-adherence', 'passed'),
      judged('house-standards', 'bouncing'),
    ]
    expect(steps[activeJudgeStepIndex(steps, 1)]?.agentKind).toBe('house-standards')
  })

  it('falls back to the LAST settled judge when the cursor is not on one', () => {
    const steps: Step[] = [
      judged('scope-adherence', 'passed'),
      judged('house-standards', 'skipped'),
      { agentKind: 'merger' },
    ]
    expect(steps[activeJudgeStepIndex(steps, 2)]?.agentKind).toBe('house-standards')
  })

  it('works without a cursor (a caller holding only the step list)', () => {
    const steps: Step[] = [judged('scope-adherence', 'passed')]
    expect(steps[activeJudgeStepIndex(steps)]?.agentKind).toBe('scope-adherence')
  })
})
