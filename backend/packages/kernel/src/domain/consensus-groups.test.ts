import { describe, expect, it } from 'vitest'
import {
  applyConsensusGroup,
  clearsConsensusBar,
  consensusGroupBar,
  selectConsensusGroup,
} from './consensus-groups.js'
import type { ConsensusGroup, ConsensusStepConfig, TaskEstimate } from './types.js'

function estimate(overrides: Partial<TaskEstimate> = {}): TaskEstimate {
  return { complexity: 0.5, risk: 0.5, impact: 0.5, rationale: '', createdAt: 1, ...overrides }
}

function group(overrides: Partial<ConsensusGroup> & Pick<ConsensusGroup, 'id'>): ConsensusGroup {
  return {
    name: overrides.id,
    strategy: 'specialist-panel',
    participants: [
      { id: 'p1', role: 'Pragmatist' },
      { id: 'p2', role: 'Skeptic' },
    ],
    gating: { enabled: false, onMissingEstimate: 'consensus' },
    createdAt: 1,
    ...overrides,
  }
}

describe('clearsConsensusBar', () => {
  it('clears unconditionally when gating is absent or disabled', () => {
    expect(clearsConsensusBar(undefined, estimate({ risk: 0 }))).toBe(true)
    expect(
      clearsConsensusBar({ enabled: false, minRisk: 0.9, onMissingEstimate: 'consensus' }, null),
    ).toBe(true)
  })

  it('clears when ANY supplied axis is met or exceeded', () => {
    const gating = {
      enabled: true,
      minRisk: 0.8,
      minImpact: 0.4,
      onMissingEstimate: 'consensus' as const,
    }
    expect(clearsConsensusBar(gating, estimate({ risk: 0.1, impact: 0.4 }))).toBe(true)
    expect(clearsConsensusBar(gating, estimate({ risk: 0.1, impact: 0.3 }))).toBe(false)
  })

  it('never clears on score when gating is enabled with no threshold', () => {
    expect(
      clearsConsensusBar(
        { enabled: true, onMissingEstimate: 'consensus' },
        estimate({ risk: 1, impact: 1, complexity: 1 }),
      ),
    ).toBe(false)
  })

  it('falls back to onMissingEstimate when the task has no estimate', () => {
    expect(
      clearsConsensusBar({ enabled: true, minRisk: 0.5, onMissingEstimate: 'consensus' }, null),
    ).toBe(true)
    expect(
      clearsConsensusBar({ enabled: true, minRisk: 0.5, onMissingEstimate: 'standard' }, undefined),
    ).toBe(false)
  })
})

describe('consensusGroupBar', () => {
  it('is the highest threshold named across the axes', () => {
    const bar = consensusGroupBar(
      group({
        id: 'g',
        gating: { enabled: true, minRisk: 0.4, minImpact: 0.7, onMissingEstimate: 'consensus' },
      }),
    )
    expect(bar).toBe(0.7)
  })

  it('sorts an ungated group below every gated one', () => {
    expect(consensusGroupBar(group({ id: 'floor' }))).toBeLessThan(
      consensusGroupBar(
        group({ id: 'g', gating: { enabled: true, minRisk: 0, onMissingEstimate: 'consensus' } }),
      ),
    )
  })
})

describe('selectConsensusGroup', () => {
  const floor = group({ id: 'a-floor' })
  const mid = group({
    id: 'b-mid',
    gating: { enabled: true, minRisk: 0.4, onMissingEstimate: 'consensus' },
  })
  const top = group({
    id: 'c-top',
    participants: [
      { id: 'p1', role: 'A' },
      { id: 'p2', role: 'B' },
      { id: 'p3', role: 'C' },
    ],
    gating: { enabled: true, minRisk: 0.8, onMissingEstimate: 'standard' },
  })

  it('picks the most demanding tier the estimate clears', () => {
    expect(selectConsensusGroup([floor, mid, top], estimate({ risk: 0.9 }))?.id).toBe('c-top')
    expect(selectConsensusGroup([floor, mid, top], estimate({ risk: 0.5 }))?.id).toBe('b-mid')
    expect(selectConsensusGroup([floor, mid, top], estimate({ risk: 0.1 }))?.id).toBe('a-floor')
  })

  it('is order-independent — the array is a set, not a precedence list', () => {
    expect(selectConsensusGroup([top, mid, floor], estimate({ risk: 0.9 }))?.id).toBe('c-top')
    expect(selectConsensusGroup([mid, top, floor], estimate({ risk: 0.5 }))?.id).toBe('b-mid')
  })

  it('returns null when nothing clears, so the step runs the standard agent', () => {
    expect(selectConsensusGroup([mid, top], estimate({ risk: 0.1 }))).toBeNull()
    expect(selectConsensusGroup([], estimate())).toBeNull()
  })

  it('honours each tier’s own onMissingEstimate for an un-estimated task', () => {
    // `mid` fails safe to consensus, `top` opts out — so the un-estimated task earns `mid`.
    expect(selectConsensusGroup([mid, top], null)?.id).toBe('b-mid')
  })

  it('breaks a tie deterministically (panel size, then id) so a replay re-picks the same tier', () => {
    const small = group({
      id: 'z-small',
      gating: { enabled: true, minRisk: 0.4, onMissingEstimate: 'consensus' },
    })
    const large = group({
      id: 'y-large',
      participants: [
        { id: 'p1', role: 'A' },
        { id: 'p2', role: 'B' },
        { id: 'p3', role: 'C' },
      ],
      gating: { enabled: true, minRisk: 0.4, onMissingEstimate: 'consensus' },
    })
    expect(selectConsensusGroup([small, large], estimate({ risk: 0.9 }))?.id).toBe('y-large')
    expect(selectConsensusGroup([large, small], estimate({ risk: 0.9 }))?.id).toBe('y-large')

    const tieA = group({
      id: 'a',
      gating: { enabled: true, minRisk: 0.4, onMissingEstimate: 'consensus' },
    })
    const tieB = group({
      id: 'b',
      gating: { enabled: true, minRisk: 0.4, onMissingEstimate: 'consensus' },
    })
    expect(selectConsensusGroup([tieB, tieA], estimate({ risk: 0.9 }))?.id).toBe('a')
  })
})

describe('applyConsensusGroup', () => {
  const config: ConsensusStepConfig = {
    enabled: true,
    strategy: 'specialist-panel',
    participants: [],
    groupIds: ['g1'],
    gating: { enabled: true, minRisk: 0.9, onMissingEstimate: 'standard' },
  }

  it('replaces the panel and stamps the tier that fired', () => {
    const applied = applyConsensusGroup(
      config,
      group({
        id: 'g1',
        name: 'Deep review',
        strategy: 'debate',
        rounds: 3,
        synthesizerModelId: 'opus',
      }),
    )
    expect(applied.strategy).toBe('debate')
    expect(applied.rounds).toBe(3)
    expect(applied.synthesizerModelId).toBe('opus')
    expect(applied.participants).toHaveLength(2)
    expect(applied.selectedGroup).toEqual({ id: 'g1', name: 'Deep review' })
    expect(applied.groupIds).toEqual(['g1'])
  })

  it('drops the step gating — selection IS the gate, so the executor must not re-decide it', () => {
    const applied = applyConsensusGroup(
      config,
      group({ id: 'g1', gating: { enabled: true, minRisk: 0.4, onMissingEstimate: 'consensus' } }),
    )
    expect(applied.gating).toBeUndefined()
  })
})
