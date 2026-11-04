import { describe, expect, it } from 'vitest'
import { catalogGatedSteps, stepOccurrenceKeys } from './pipeline-approvals.js'

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
