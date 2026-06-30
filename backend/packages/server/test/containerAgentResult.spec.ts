import { describe, expect, it } from 'vitest'
import type { RunnerJobResult } from '@cat-factory/kernel'
import {
  BLUEPRINTS_AGENT_KIND,
  MERGER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  TESTER_AGENT_KIND,
} from '@cat-factory/orchestration'
import { toRunResult } from '../src/agents/containerAgentResult.js'

// Characterisation tests pinning the runner-output → engine-result normalisation that was
// extracted verbatim from ContainerAgentExecutor.ts. They lock in the conservative
// coercions (merge/on-call/test) and the structural PR / pushed branches so the move is
// provably behaviour-preserving.
const result = (over: Partial<RunnerJobResult>): RunnerJobResult => over as RunnerJobResult

describe('toRunResult', () => {
  it('surfaces an opened PR structurally (PR wins over pushed)', () => {
    const r = toRunResult(
      result({ pushed: true, prUrl: 'https://github.com/o/r/pull/42', branch: 'feature/x' }),
    )
    expect(r.pullRequest).toEqual({
      url: 'https://github.com/o/r/pull/42',
      number: 42,
      branch: 'feature/x',
    })
    expect(r.output).toContain('PR: https://github.com/o/r/pull/42')
  })

  it('maps an in-place pushed job to a sensible output', () => {
    expect(toRunResult(result({ pushed: true })).output).toBe('Pushed changes to the branch.')
    expect(toRunResult(result({ pushed: false })).output).toBe('No changes were produced.')
  })

  it('passes a registered custom kind through as custom', () => {
    const r = toRunResult(result({ custom: { foo: 'bar' }, summary: 'done' }), 'some-custom-kind')
    expect(r.custom).toEqual({ foo: 'bar' })
    expect(r.output).toBe('done')
  })

  it('honours the spec-writer noBusinessSpecs flag (no spec committed)', () => {
    const r = toRunResult(result({ custom: { noBusinessSpecs: true } }), SPEC_WRITER_AGENT_KIND)
    expect(r.noBusinessSpecs).toBe(true)
    expect(r.spec).toBeUndefined()
  })

  it('leaves blueprintService unset for a nameless/garbage tree', () => {
    const r = toRunResult(result({ custom: { not: 'a tree' } }), BLUEPRINTS_AGENT_KIND)
    expect(r.blueprintService).toBeUndefined()
    expect(r.output).toBe('Service blueprint updated.')
  })

  it('coerces a garbage merger assessment to the conservative 1/1/1 default', () => {
    const r = toRunResult(result({ custom: null, summary: 'looked at it' }), MERGER_AGENT_KIND)
    expect(r.mergeAssessment).toEqual({
      complexity: 1,
      risk: 1,
      impact: 1,
      rationale: 'looked at it',
    })
  })

  it('coerces a garbage on-call assessment to confidence 0 / hold', () => {
    const r = toRunResult(result({ custom: {}, summary: 'investigated' }), ON_CALL_AGENT_KIND)
    expect(r.onCallAssessment).toEqual({
      culpritConfidence: 0,
      recommendation: 'hold',
      rationale: 'investigated',
      evidence: [],
    })
  })

  it('honours a tester greenlight only when no blocking concern is open', () => {
    const passing = toRunResult(
      result({ custom: { greenlight: true, concerns: [] } }),
      TESTER_AGENT_KIND,
    )
    expect((passing.testReport as { greenlight: boolean }).greenlight).toBe(true)

    const blocked = toRunResult(
      result({
        custom: { greenlight: true, concerns: [{ title: 'x', severity: 'high' }] },
      }),
      TESTER_AGENT_KIND,
    )
    expect((blocked.testReport as { greenlight: boolean }).greenlight).toBe(false)
  })

  it('forces a tester greenlight off when the run aborted', () => {
    const r = toRunResult(
      result({ custom: { greenlight: true, abort: { reason: 'env never came up' } } }),
      TESTER_AGENT_KIND,
    )
    const report = r.testReport as { greenlight: boolean; abort?: { reason: string } }
    expect(report.greenlight).toBe(false)
    expect(report.abort).toEqual({ reason: 'env never came up' })
  })
})
