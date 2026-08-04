import type { AgentJobHandle, PipelineStep } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { recordDispatchAttribution } from './step-fold.logic.js'

// `recordDispatchAttribution` is the one funnel every dispatch site calls right after
// `startJob`, which is why the dispatched KIND is recorded here rather than at each site: a step
// routinely runs work under a kind that is not its own, every telemetry row that work produces
// is tagged with that kind, and nothing else on the step says so afterwards.

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'ci', state: 'working', progress: 0, ...overrides } as PipelineStep
}

const handle = { jobId: 'job_1' } as AgentJobHandle

describe('recordDispatchAttribution — dispatched kinds', () => {
  it("records a helper kind that is not the step's own", () => {
    const s = step()
    recordDispatchAttribution(s, handle, 'ci-fixer')
    expect(s.dispatches).toEqual([{ agentKind: 'ci-fixer', count: 1 }])
  })

  it('counts re-dispatches of one kind rather than deduplicating them', () => {
    // The count IS the cycle: four fixer rounds and one round are the same picture without it.
    const s = step()
    for (let i = 0; i < 4; i++) recordDispatchAttribution(s, handle, 'ci-fixer')
    expect(s.dispatches).toEqual([{ agentKind: 'ci-fixer', count: 4 }])
  })

  it('keeps kinds in first-dispatch order', () => {
    const s = step({ agentKind: 'coder' })
    recordDispatchAttribution(s, handle, 'fork-proposer')
    recordDispatchAttribution(s, handle, 'coder')
    recordDispatchAttribution(s, handle, 'fork-proposer')
    expect(s.dispatches).toEqual([
      { agentKind: 'fork-proposer', count: 2 },
      { agentKind: 'coder', count: 1 },
    ])
  })

  it('still records the attribution a handle carries', () => {
    const s = step()
    recordDispatchAttribution(
      s,
      { jobId: 'job_1', model: 'claude-x', initiatedByUserId: 'u1' } as AgentJobHandle,
      'ci-fixer',
    )
    expect([s.model, s.initiatedByUserId]).toEqual(['claude-x', 'u1'])
  })
})
