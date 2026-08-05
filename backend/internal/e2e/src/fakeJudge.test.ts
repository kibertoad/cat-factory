import { describe, expect, it } from 'vitest'
import { DEFAULT_JUDGE_MIN_SCORE } from '@cat-factory/contracts'
import { E2eJudgeAssessor, verdictFor } from './fakeJudge.ts'
import { FakeProfileRegistry } from './fakeProfile.ts'

// The judge assessor's per-workspace ROUND COUNTER is what makes a bounce loop assertable: the
// engine calls `assess` once per round, and `judge-gate.spec.ts` drives "bounced then passed"
// against "parked when the budget ran out" off scripts that differ in their second entry. A counter
// shared across workspaces (or reset per call) would make both specs pass or fail for reasons
// unrelated to the engine, so it is pinned here rather than in a browser.

/** The score the assessor reports for the next round of `workspaceId`. */
async function nextScore(assessor: E2eJudgeAssessor, workspaceId: string): Promise<number> {
  const { verdict } = await assessor.assess({ workspaceId } as never)
  return (verdict as { score: number }).score
}

describe('E2eJudgeAssessor', () => {
  it('replays a workspace’s script, repeating its last entry', async () => {
    const registry = new FakeProfileRegistry()
    const assessor = new E2eJudgeAssessor(registry)
    registry.set('ws_1', { judgeScores: [0.4, 0.9] })

    expect(await nextScore(assessor, 'ws_1')).toBe(0.4)
    expect(await nextScore(assessor, 'ws_1')).toBe(0.9)
    expect(await nextScore(assessor, 'ws_1')).toBe(0.9)
  })

  it('counts rounds per workspace, so one spec’s judge cannot consume another’s script', async () => {
    const registry = new FakeProfileRegistry()
    const assessor = new E2eJudgeAssessor(registry)
    registry.set('ws_1', { judgeScores: [0.4, 0.9] })
    registry.set('ws_2', { judgeScores: [0.4, 0.9] })

    expect(await nextScore(assessor, 'ws_1')).toBe(0.4)
    expect(await nextScore(assessor, 'ws_2')).toBe(0.4)
    expect(await nextScore(assessor, 'ws_1')).toBe(0.9)
  })

  it('passes by default, so a workspace that places no judge step is unaffected', async () => {
    const registry = new FakeProfileRegistry()
    const assessor = new E2eJudgeAssessor(registry)
    expect(assessor.enabled).toBe(true)
    expect(await nextScore(assessor, 'ws_unscripted')).toBe(1)
  })

  it('is re-armed by a profile write, which restarts the round sequence', async () => {
    const registry = new FakeProfileRegistry()
    const assessor = new E2eJudgeAssessor(registry)
    registry.set('ws_1', { judgeScores: [0.4, 0.9] })
    expect(await nextScore(assessor, 'ws_1')).toBe(0.4)

    registry.set('ws_1', { judgeScores: [0.4, 0.9] })
    expect(await nextScore(assessor, 'ws_1')).toBe(0.4)
  })
})

describe('verdictFor', () => {
  it('carries findings only when the work actually failed the rubric', () => {
    expect(verdictFor(0.4).findings).toHaveLength(1)
    // A passing verdict with findings would render as a rubric complaint about work it cleared.
    expect(verdictFor(1).findings).toEqual([])
  })

  it('draws the line at the ENGINE’s bar, not at a perfect score', () => {
    // The boundary that actually bites: `judge-gate.spec.ts`'s pass round scores 0.9, which clears
    // the threshold without being perfect. Gating findings on `< 1` sent a high-severity rubric
    // complaint along with the verdict that let the work through. Both bounds are derived from the
    // constant the engine reads, so raising the default bar cannot silently re-open the gap.
    expect(verdictFor(DEFAULT_JUDGE_MIN_SCORE - 0.01).findings).toHaveLength(1)
    expect(verdictFor(DEFAULT_JUDGE_MIN_SCORE).findings).toEqual([])
    expect(verdictFor(DEFAULT_JUDGE_MIN_SCORE + 0.01).findings).toEqual([])
    // The spec's own passing script value, spelled out because it is the case that regressed.
    expect(verdictFor(0.9).findings).toEqual([])
  })
})
