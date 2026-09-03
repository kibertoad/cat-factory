import { describe, expect, it } from 'vitest'
import { BUG_FISHING_PHASES, type BugFishingStepState } from '@cat-factory/kernel'
import {
  coerceBugFishingFindings,
  describeRecordedPhase,
  BUG_FISHING_SPAWN_CLAIM_TTL_MS,
  bugFishingSpawnIsClaimable,
  claimBugFishingSpawn,
  dismissBugFishingFinding,
  failBugFishingPhase,
  planBugFishingPhases,
  priorBugFishingFindingTitles,
  recordBugFishingPhase,
  settleBugFishingSpawn,
  startBugFishingPhase,
  untriagedBugFishingFindings,
} from './bugFishing.logic.js'

let seq = 0
const mintId = () => `bff_${++seq}`

function stateWith(overrides: Partial<BugFishingStepState> = {}): BugFishingStepState {
  return {
    status: 'fishing',
    phases: planBugFishingPhases(['control-flow', 'concurrency']).phases,
    currentPhaseIndex: 0,
    findings: [],
    ...overrides,
  }
}

describe('planBugFishingPhases', () => {
  it('plans the whole catalog when nothing is selected', () => {
    // The default is deliberately "everything": an expedition exists to cover ground nobody
    // thought to look at, so narrowing it has to be the deliberate act.
    const { phases, unknown } = planBugFishingPhases(undefined)
    expect(phases).toHaveLength(BUG_FISHING_PHASES.length)
    expect(unknown).toEqual([])
    expect(phases.every((p) => p.status === 'pending')).toBe(true)
  })

  it('plans the selection in CATALOG order, not selection order', () => {
    const { phases } = planBugFishingPhases(['concurrency', 'control-flow'])
    expect(phases.map((p) => p.id)).toEqual(['control-flow', 'concurrency'])
  })

  it('copies the title and goal onto the plan rather than leaving a lookup for later', () => {
    // A run keeps naming the angle it actually fished even after the catalog reworks or retires
    // it, which is what lets the window render an old expedition honestly.
    const { phases } = planBugFishingPhases(['footguns'])
    expect(phases[0]!.title).toBe(BUG_FISHING_PHASES.find((p) => p.id === 'footguns')!.title)
    expect(phases[0]!.goal).toBeTruthy()
  })

  it('reports an unrecognised angle instead of silently fishing fewer', () => {
    const { phases, unknown } = planBugFishingPhases(['control-flow', 'astrology'])
    expect(phases.map((p) => p.id)).toEqual(['control-flow'])
    expect(unknown).toEqual(['astrology'])
  })

  it('falls back to the whole catalog when EVERY selected angle is unrecognised', () => {
    // Fishing nothing would park a human in front of an empty expedition; fishing everything is
    // the same answer they get by selecting nothing, and the dropped ids are reported either way.
    const { phases, unknown } = planBugFishingPhases(['astrology'])
    expect(phases).toHaveLength(BUG_FISHING_PHASES.length)
    expect(unknown).toEqual(['astrology'])
  })
})

describe('coerceBugFishingFindings', () => {
  it('stamps the phase, mints ids and orders by severity', () => {
    const { findings } = coerceBugFishingFindings(
      {
        summary: 'x',
        findings: [
          {
            path: 'a.ts',
            severity: 'low',
            kind: 'other',
            confidence: 'low',
            title: 'L',
            detail: 'l',
          },
          {
            path: 'b.ts',
            severity: 'critical',
            kind: 'bug',
            confidence: 'high',
            title: 'C',
            detail: 'c',
          },
        ],
      } as never,
      'control-flow',
      mintId,
    )
    expect(findings.map((f) => f.title)).toEqual(['C', 'L'])
    expect(findings.every((f) => f.phaseId === 'control-flow')).toBe(true)
    expect(findings[0]!.id).toMatch(/^bff_/)
    expect(findings[0]!.spawn).toBeNull()
    expect(findings[0]!.dismissed).toBe(false)
  })

  it('drops an entry with neither a title nor a detail', () => {
    // The lenient agent schema fills both with '' rather than failing the parse, so an entry
    // carrying neither is an artefact of that leniency and not something a human could triage.
    const { findings } = coerceBugFishingFindings(
      {
        findings: [
          {
            path: 'a.ts',
            severity: 'low',
            kind: 'other',
            confidence: 'low',
            title: '',
            detail: '',
          },
          {
            path: 'b.ts',
            severity: 'low',
            kind: 'other',
            confidence: 'low',
            title: '',
            detail: 'has a body',
          },
        ],
      } as never,
      'boundaries',
      mintId,
    )
    expect(findings).toHaveLength(1)
    // A finding with a body but no headline gets one from its body rather than an empty row.
    expect(findings[0]!.title).toBe('has a body')
  })

  it('keeps a finding that names no path', () => {
    // An expedition can legitimately report a gap that spans files; blanking the row would be
    // the platform deciding it did not happen.
    const { findings } = coerceBugFishingFindings(
      {
        findings: [
          {
            path: '',
            severity: 'high',
            kind: 'logic-gap',
            confidence: 'medium',
            title: 'T',
            detail: 'd',
          },
        ],
      } as never,
      'contracts',
      mintId,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.path).toBe('')
  })

  it('reports how many findings the per-phase cap dropped', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      path: 'a.ts',
      severity: 'low' as const,
      kind: 'other' as const,
      confidence: 'low' as const,
      title: `f${i}`,
      detail: 'd',
    }))
    const { findings, dropped } = coerceBugFishingFindings(
      { findings: many } as never,
      'footgun',
      mintId,
    )
    expect(findings).toHaveLength(40)
    expect(dropped).toBe(5)
  })
})

describe('recordBugFishingPhase', () => {
  it('settles the pass, appends its catch and moves to the next angle', () => {
    const state = stateWith()
    const { findings } = coerceBugFishingFindings(
      {
        summary: 'covered the write paths',
        findings: [
          {
            path: 'a.ts',
            severity: 'high',
            kind: 'bug',
            confidence: 'high',
            title: 'T',
            detail: 'd',
          },
        ],
      } as never,
      'control-flow',
      mintId,
    )
    const next = recordBugFishingPhase(state, 0, {
      summary: 'covered the write paths',
      findings,
      dropped: 0,
      at: 1000,
    })
    expect(next.phases?.[0]?.status).toBe('completed')
    expect(next.phases?.[0]?.summary).toBe('covered the write paths')
    expect(next.phases?.[0]?.settledAt).toBe(1000)
    expect(next.currentPhaseIndex).toBe(1)
    expect(next.findings).toHaveLength(1)
    // Angles remain, so the expedition is still fishing rather than ready for triage.
    expect(next.status).toBe('fishing')
  })

  it('parks for triage once the LAST angle settles', () => {
    const state = stateWith({ currentPhaseIndex: 1 })
    const next = recordBugFishingPhase(state, 1, { summary: null, findings: [], dropped: 0, at: 1 })
    expect(next.status).toBe('awaiting_triage')
    expect(next.currentPhaseIndex).toBe(2)
  })

  it('accumulates across passes rather than replacing the previous catch', () => {
    let state = stateWith()
    const one = coerceBugFishingFindings(
      {
        findings: [
          {
            path: 'a.ts',
            severity: 'high',
            kind: 'bug',
            confidence: 'high',
            title: 'A',
            detail: 'a',
          },
        ],
      } as never,
      'control-flow',
      mintId,
    )
    state = recordBugFishingPhase(state, 0, { summary: null, ...one, at: 1 })
    const two = coerceBugFishingFindings(
      {
        findings: [
          {
            path: 'b.ts',
            severity: 'low',
            kind: 'bug',
            confidence: 'low',
            title: 'B',
            detail: 'b',
          },
        ],
      } as never,
      'concurrency',
      mintId,
    )
    state = recordBugFishingPhase(state, 1, { summary: null, ...two, at: 2 })
    expect(state.findings?.map((f) => f.title)).toEqual(['A', 'B'])
    expect(state.findings?.map((f) => f.phaseId)).toEqual(['control-flow', 'concurrency'])
  })

  it('names a dropped tail in the phase summary rather than leaving a silent prefix', () => {
    const next = recordBugFishingPhase(stateWith(), 0, {
      summary: 'found a lot',
      findings: [],
      dropped: 5,
      at: 1,
    })
    expect(next.phases?.[0]?.summary).toContain('found a lot')
    expect(next.phases?.[0]?.summary).toContain('5')
  })
})

describe('failBugFishingPhase', () => {
  it('names the failure on the phase and carries on with the next angle', () => {
    // A phase that silently reported nothing is indistinguishable from one that honestly found
    // nothing, which is why the reason is recorded rather than dropped.
    const next = failBugFishingPhase(stateWith(), 0, 'container evicted', 500)
    expect(next.phases?.[0]?.status).toBe('failed')
    expect(next.phases?.[0]?.failureReason).toBe('container evicted')
    expect(next.currentPhaseIndex).toBe(1)
    expect(next.status).toBe('fishing')
  })

  it('still parks for triage when the LAST angle is the one that failed', () => {
    const next = failBugFishingPhase(stateWith({ currentPhaseIndex: 1 }), 1, null, 500)
    expect(next.status).toBe('awaiting_triage')
    expect(next.phases?.[1]?.failureReason).toBeTruthy()
  })
})

describe('triage reductions', () => {
  const seeded = () => {
    const { findings } = coerceBugFishingFindings(
      {
        findings: [
          {
            path: 'a.ts',
            severity: 'high',
            kind: 'bug',
            confidence: 'high',
            title: 'A',
            detail: 'a',
          },
          {
            path: 'b.ts',
            severity: 'low',
            kind: 'bug',
            confidence: 'low',
            title: 'B',
            detail: 'b',
          },
        ],
      } as never,
      'control-flow',
      mintId,
    )
    return { state: stateWith({ findings }), findings }
  }

  const NOW = 1_000_000
  const claim = (taskId: string, at = NOW) => ({
    status: 'pending' as const,
    taskId,
    executionId: null,
    pipelineId: 'pl_bugfix',
    requestedBy: 'usr_1',
    requestedAt: at,
  })

  it('claims the marked finding only', () => {
    const { state, findings } = seeded()
    const next = claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW)
    expect(next.findings?.[0]?.spawn).toMatchObject({ status: 'pending', taskId: 'blk_x' })
    expect(next.findings?.[1]?.spawn).toBeNull()
  })

  // The whole point of claiming BEFORE the task exists: the second marker's transform must be a
  // no-op, so it can tell it lost by finding somebody else's task id on the finding.
  it('leaves a claim already held by another marking alone', () => {
    const { state, findings } = seeded()
    const first = claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW)
    const second = claimBugFishingSpawn(first, findings[0]!.id, claim('blk_y'), NOW)
    expect(second.findings?.[0]?.spawn?.taskId).toBe('blk_x')
  })

  it('re-claims a finding whose last mark failed, and one whose claim outlived its TTL', () => {
    const { state, findings } = seeded()
    const failed = settleBugFishingSpawn(
      claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW),
      findings[0]!.id,
      'blk_x',
      { status: 'failed', failureReason: 'the run would not start' },
    )
    expect(
      claimBugFishingSpawn(failed, findings[0]!.id, claim('blk_y'), NOW).findings?.[0]?.spawn
        ?.taskId,
    ).toBe('blk_y')

    const stale = claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW)
    const later = NOW + BUG_FISHING_SPAWN_CLAIM_TTL_MS
    expect(
      claimBugFishingSpawn(stale, findings[0]!.id, claim('blk_z'), later).findings?.[0]?.spawn
        ?.taskId,
    ).toBe('blk_z')
    // …but not one second before it: a merely slow start must never be re-claimed, which would
    // be exactly the double spawn the claim exists to prevent.
    expect(
      claimBugFishingSpawn(stale, findings[0]!.id, claim('blk_z'), later - 1).findings?.[0]?.spawn
        ?.taskId,
    ).toBe('blk_x')
  })

  it('settles only the claim the caller owns', () => {
    const { state, findings } = seeded()
    const claimed = claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW)
    const settled = settleBugFishingSpawn(claimed, findings[0]!.id, 'blk_x', {
      status: 'spawned',
      executionId: 'exe_x',
    })
    expect(settled.findings?.[0]?.spawn).toMatchObject({
      status: 'spawned',
      taskId: 'blk_x',
      executionId: 'exe_x',
    })
    // A settle from a caller whose claim expired and was re-taken must not report its outcome
    // against the winner's task.
    const foreign = settleBugFishingSpawn(settled, findings[0]!.id, 'blk_y', {
      status: 'failed',
      failureReason: 'nope',
    })
    expect(foreign.findings?.[0]?.spawn?.status).toBe('spawned')
  })

  it('keeps a dismissed finding on the record', () => {
    // The record is what a human reads to decide whether the hunt was worth running: deleting a
    // rejected finding would make every expedition look flawless.
    const { state, findings } = seeded()
    const next = dismissBugFishingFinding(state, findings[1]!.id, NOW)
    expect(next.findings).toHaveLength(2)
    expect(next.findings?.[1]?.dismissed).toBe(true)
  })

  it('refuses to dismiss a finding whose fix task exists or is being created', () => {
    const { state, findings } = seeded()
    const claimed = claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW)
    expect(dismissBugFishingFinding(claimed, findings[0]!.id, NOW).findings?.[0]?.dismissed).toBe(
      false,
    )
    const spawned = settleBugFishingSpawn(claimed, findings[0]!.id, 'blk_x', {
      status: 'spawned',
      executionId: 'exe_x',
    })
    expect(dismissBugFishingFinding(spawned, findings[0]!.id, NOW).findings?.[0]?.dismissed).toBe(
      false,
    )
  })

  it('counts a finding whose mark FAILED as still untriaged', () => {
    // The human decided and the platform did not carry it out. Counting it as done is how "N to
    // triage" comes to under-report exactly on the runs where something went wrong.
    const { state, findings } = seeded()
    const claimed = claimBugFishingSpawn(state, findings[0]!.id, claim('blk_x'), NOW)
    expect(untriagedBugFishingFindings(claimed, NOW).map((f) => f.title)).toEqual(['B'])
    const spawned = settleBugFishingSpawn(claimed, findings[0]!.id, 'blk_x', {
      status: 'spawned',
      executionId: 'exe_x',
    })
    expect(untriagedBugFishingFindings(spawned, NOW).map((f) => f.title)).toEqual(['B'])
    const failed = settleBugFishingSpawn(claimed, findings[0]!.id, 'blk_x', {
      status: 'failed',
      failureReason: 'the run would not start',
    })
    expect(untriagedBugFishingFindings(failed, NOW).map((f) => f.title)).toEqual(['A', 'B'])
    expect(
      untriagedBugFishingFindings(dismissBugFishingFinding(spawned, findings[1]!.id, NOW), NOW),
    ).toEqual([])
  })

  it('answers claimability from the status, never from the record being present', () => {
    expect(bugFishingSpawnIsClaimable(null, NOW)).toBe(true)
    expect(bugFishingSpawnIsClaimable(claim('blk_x'), NOW)).toBe(false)
    expect(
      bugFishingSpawnIsClaimable({ ...claim('blk_x'), status: 'spawned' }, NOW + 10 ** 9),
    ).toBe(false)
    expect(bugFishingSpawnIsClaimable({ ...claim('blk_x'), status: 'failed' }, NOW)).toBe(true)
  })

  it('briefs the next pass with EVERY earlier title, dismissed ones included', () => {
    // A human rejecting a finding says they do not want it fixed, not that the next angle should
    // raise it again.
    const { state, findings } = seeded()
    const next = dismissBugFishingFinding(state, findings[1]!.id, NOW)
    expect(priorBugFishingFindingTitles(next)).toEqual(['A', 'B'])
  })
})

describe('startBugFishingPhase', () => {
  it('marks the angle now in flight without touching the others', () => {
    const next = startBugFishingPhase(stateWith(), 1)
    expect(next.phases?.map((p) => p.status)).toEqual(['pending', 'fishing'])
    expect(next.currentPhaseIndex).toBe(1)
  })
})

describe('describeRecordedPhase', () => {
  it("prefers the run's OWN record over the catalog placeholder for a retired angle", () => {
    // The expedition genuinely fished that angle and its own record is the better witness; only
    // an id with nothing recorded at all falls through to the "retired" placeholder.
    const described = describeRecordedPhase({
      id: 'astrology',
      title: 'Astrological alignment',
      goal: 'Find what the stars foretold.',
      status: 'completed',
    })
    expect(described.title).toBe('Astrological alignment')
    expect(described.goal).toBe('Find what the stars foretold.')
    expect(described.retired).toBe(true)
  })

  it('falls back to the catalog when the run recorded no title', () => {
    const described = describeRecordedPhase({
      id: 'footguns',
      title: '',
      goal: '',
      status: 'completed',
    })
    expect(described.title).toBe(BUG_FISHING_PHASES.find((p) => p.id === 'footguns')!.title)
  })
})

describe('secret scrubbing', () => {
  it('scrubs a credential the agent quoted out of the repository', () => {
    // `evidence` is code read from the checkout, so a checked-in credential reaches a finding the
    // same way it reaches any captured output — and from there four surfaces, only one of which
    // would be an obvious place to remember to scrub.
    const { findings } = coerceBugFishingFindings(
      {
        findings: [
          {
            path: 'src/a.ts',
            severity: 'high',
            kind: 'bug',
            confidence: 'high',
            title: 'Token is hard-coded',
            detail: 'The default falls back to a literal.',
            evidence: 'const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"',
          },
        ],
      } as never,
      'boundaries',
      mintId,
    )
    expect(findings[0]!.evidence).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')
  })
})
