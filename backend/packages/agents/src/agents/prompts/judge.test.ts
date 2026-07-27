import type { JudgeSubject } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { renderJudgePrompt } from './judge.js'

function subject(overrides: Partial<JudgeSubject> = {}): JudgeSubject {
  return {
    workspaceId: 'ws_1',
    block: { id: 'blk_1', title: 'Add login', description: 'Add a login form.' },
    step: { agentKind: 'scope-adherence' },
    rubric: 'Implement what was asked and nothing else.',
    rubricName: 'Scope adherence',
    priorOutputs: [],
    ...overrides,
  } as unknown as JudgeSubject
}

/** N prior outputs of `chars` each — the shape a long pipeline hands the assessor. */
function priorOutputs(count: number, chars: number): { agentKind: string; output: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    agentKind: `step-${i}`,
    output: `${i}`.repeat(chars),
  }))
}

describe('renderJudgePrompt', () => {
  it('folds in the rubric, the task and the work under review', () => {
    const prompt = renderJudgePrompt(
      subject({ priorOutputs: [{ agentKind: 'coder', output: 'wrote the form' }] }),
    )
    expect(prompt).toContain('Implement what was asked and nothing else.')
    expect(prompt).toContain('Task: Add login')
    expect(prompt).toContain('Output of the "coder" step')
    expect(prompt).toContain('wrote the form')
  })

  it('caps ONE oversized output without dropping it', () => {
    const prompt = renderJudgePrompt(subject({ priorOutputs: priorOutputs(1, 20_000) }))
    expect(prompt).toContain('[truncated]')
    expect(prompt.length).toBeLessThan(12_000)
  })

  it('bounds the TOTAL prompt across many outputs, keeping the newest', () => {
    // The per-entry cap alone is not a bound: a long pipeline multiplies it, and a bounce pays
    // the whole prompt again on every round.
    const prompt = renderJudgePrompt(subject({ priorOutputs: priorOutputs(15, 6_000) }))
    expect(prompt.length).toBeLessThan(30_000)
    // The LAST step's output is what the judge is scoring, so it must survive.
    expect(prompt).toContain('Output of the "step-14" step')
    // The earliest ones are what gets dropped.
    expect(prompt).not.toContain('Output of the "step-0" step')
  })

  it('SAYS what it dropped rather than silently scoring a subset', () => {
    // A judge whose summary reads as if it saw everything, having seen half, produces a verdict
    // a human cannot calibrate — the same reason the PR report logs its truncations.
    const prompt = renderJudgePrompt(subject({ priorOutputs: priorOutputs(15, 6_000) }))
    expect(prompt).toMatch(/\d+ earlier step output\(s\) omitted/)
  })

  it('never drops the only output it has, however long', () => {
    const prompt = renderJudgePrompt(subject({ priorOutputs: priorOutputs(1, 100_000) }))
    expect(prompt).toContain('Output of the "step-0" step')
    expect(prompt).not.toMatch(/earlier step output\(s\) omitted/)
  })

  it('names the previous round on a re-judgement so it can tell fixed from untouched', () => {
    const prompt = renderJudgePrompt(
      subject({
        priorOutputs: [{ agentKind: 'coder', output: 'v2' }],
        previousFindings: {
          score: 0.3,
          summary: 'Too much unrelated work.',
          findings: [{ title: 'Drive-by rename', severity: 'high' }],
        },
      }),
    )
    expect(prompt).toContain('0.30')
    expect(prompt).toContain('Drive-by rename')
    expect(prompt).toContain('whether it was addressed')
  })
})
