import { describe, expect, it } from 'vitest'
import {
  checkpointPlacement,
  droppedApproverPolicies,
  droppedCheckpoints,
  foldCompanionUnits,
  placementGates,
  unreachableCheckpoints,
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

describe('droppedApproverPolicies', () => {
  const policy = { gateConfig: { approvers: { roles: ['admin' as const] } } }

  it('names a step that kept its checkpoint but lost its approver policy', () => {
    const before = {
      agentKinds: ['architect', 'coder'],
      gates: [true, false],
      stepOptions: [policy, null],
    }
    const after = { agentKinds: ['researcher', 'architect', 'coder'], gates: [false, true, false] }
    expect(droppedApproverPolicies(before, after)).toEqual(['architect'])
  })

  it('names nothing when the policy survived, or when the checkpoint itself went', () => {
    const before = { agentKinds: ['architect'], gates: [true], stepOptions: [policy] }
    expect(droppedApproverPolicies(before, before)).toEqual([])
    expect(droppedApproverPolicies(before, { agentKinds: ['architect'] })).toEqual([])
  })
})

describe('unreachableCheckpoints', () => {
  it('marks an estimate-gated producer and the companion that reviews it', () => {
    expect(
      unreachableCheckpoints({
        agentKinds: ['architect', 'architect-companion', 'coder'],
        gating: [{ enabled: true, minRisk: 3, onMissingEstimate: 'run' }, null, null],
      }),
    ).toEqual([true, true, false])
  })
})
