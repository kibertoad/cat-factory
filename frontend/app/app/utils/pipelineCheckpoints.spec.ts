import { describe, expect, it } from 'vitest'
import {
  checkpointPlacement,
  droppedCheckpoints,
  foldCompanionUnits,
  patchedGateConfig,
  placementGates,
} from '~/utils/pipelineCheckpoints'

describe('foldCompanionUnits', () => {
  it('folds a companion into the row of the producer it directly follows', () => {
    expect(foldCompanionUnits(['architect', 'architect-companion', 'coder', 'reviewer'])).toEqual([
      { index: 0, kind: 'architect', companionIndex: 1 },
      { index: 2, kind: 'coder', companionIndex: 3 },
    ])
  })

  it('keeps a stray companion as a row of its own, so every step belongs to one row', () => {
    expect(foldCompanionUnits(['reviewer', 'coder'])).toEqual([
      { index: 0, kind: 'reviewer', companionIndex: null },
      { index: 1, kind: 'coder', companionIndex: null },
    ])
  })
})

describe('checkpoint placement', () => {
  it('round-trips every placement through the two gate flags', () => {
    for (const placement of ['none', 'producer', 'companion', 'both'] as const) {
      const { producer, companion } = placementGates(placement)
      expect(checkpointPlacement(producer, companion)).toBe(placement)
    }
  })
})

describe('patchedGateConfig', () => {
  it('keeps the other options and drops what returned to its default', () => {
    expect(
      patchedGateConfig(
        { retainEnvironment: true, gateConfig: { minApprovals: 2 } },
        {
          minApprovals: 1,
        },
      ),
    ).toEqual({ retainEnvironment: true })
    expect(patchedGateConfig(null, { approvers: { roles: [] } })).toBeNull()
  })
})

describe('droppedCheckpoints', () => {
  it('names a checkpoint the reseeded row lost, matched by step rather than position', () => {
    const before = { agentKinds: ['architect', 'coder'], gates: [true, true] }
    const after = {
      agentKinds: ['task-estimator', 'architect', 'coder'],
      gates: [false, false, true],
    }
    expect(droppedCheckpoints(before, after)).toEqual(['architect'])
  })
})
