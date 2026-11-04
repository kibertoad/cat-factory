import { describe, expect, it } from 'vitest'
import {
  catalogGatedSteps,
  checkpointSkippedBy,
  lockedCheckpoints,
  stepOccurrenceKeys,
} from './pipeline-approvals.js'

describe('stepOccurrenceKeys', () => {
  it('numbers each kind by its own occurrences, not by position', () => {
    expect(stepOccurrenceKeys(['coder', 'reviewer', 'coder'])).toEqual([
      'coder#0',
      'reviewer#0',
      'coder#1',
    ])
  })
})

describe('catalogGatedSteps', () => {
  const catalog = {
    agentKinds: ['clarity-review', 'coder', 'reviewer'],
    gates: [true, false, false],
  }

  it('finds a shipped checkpoint on the same step after the chain moved', () => {
    expect(catalogGatedSteps(['researcher', 'clarity-review', 'coder'], catalog)).toEqual([
      false,
      true,
      false,
    ])
  })

  it('reports nothing for a pipeline with no catalog definition', () => {
    expect(catalogGatedSteps(['clarity-review'], undefined)).toEqual([false])
  })
})

describe('lockedCheckpoints', () => {
  const catalog = { agentKinds: ['clarity-review', 'coder'], gates: [true, false] }

  it('locks a shipped checkpoint only on a row that carries it', () => {
    expect(
      lockedCheckpoints({ agentKinds: ['clarity-review', 'coder'], gates: [true, true] }, catalog),
    ).toEqual([true, false])
    expect(lockedCheckpoints({ agentKinds: ['clarity-review', 'coder'] }, catalog)).toEqual([
      false,
      false,
    ])
  })
})

describe('checkpointSkippedBy', () => {
  const isCompanion = (kind: string) => kind === 'architect-companion'
  const agentKinds = ['estimator', 'architect', 'architect-companion', 'coder']

  it('names the step itself when it may be skipped', () => {
    const gating = [
      null,
      { enabled: true, minComplexity: 3, onMissingEstimate: 'run' as const },
      null,
      null,
    ]
    expect(checkpointSkippedBy({ agentKinds, gating }, 1, isCompanion)).toBe(1)
  })

  it('names the producer a companion reviews when the producer may be skipped', () => {
    const stepOptions = [null, { condition: { serviceScope: 'frontend' as const } }, null, null]
    expect(checkpointSkippedBy({ agentKinds, stepOptions }, 2, isCompanion)).toBe(1)
  })

  it('looks past a disabled step for the producer, and is null when nothing may skip', () => {
    const kinds = ['architect', 'researcher', 'architect-companion']
    const gating = [{ enabled: true, minRisk: 3, onMissingEstimate: 'run' as const }, null, null]
    expect(
      checkpointSkippedBy(
        { agentKinds: kinds, enabled: [true, false, true], gating },
        2,
        isCompanion,
      ),
    ).toBe(0)
    expect(checkpointSkippedBy({ agentKinds }, 2, isCompanion)).toBeNull()
  })
})
