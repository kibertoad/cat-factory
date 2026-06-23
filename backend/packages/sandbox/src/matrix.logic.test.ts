import { describe, expect, it } from 'vitest'
import type { SandboxExperiment } from '@cat-factory/kernel'
import { cellCount, expandMatrix, isRunnableMatrix } from './matrix.logic.js'

const matrix = {
  promptVersionIds: ['pv_1', 'pv_2'],
  models: ['anthropic:claude-opus-4-8', 'openai:gpt-4o'],
  fixtureIds: ['fx_1'],
}

const experiment: Pick<SandboxExperiment, 'id' | 'matrix' | 'repeats'> = {
  id: 'exp_1',
  matrix,
  repeats: 2,
}

const deps = {
  makeId: (i: number) => `run_${i}`,
  labelFor: (pv: string) => `${pv}@v1`,
  now: 1000,
}

describe('cellCount', () => {
  it('multiplies every axis by repeats', () => {
    expect(cellCount(matrix, 2)).toBe(2 * 2 * 1 * 2)
    expect(cellCount(matrix, 1)).toBe(4)
  })
})

describe('expandMatrix', () => {
  it('emits one queued cell per prompt × model × fixture × repeat', () => {
    const runs = expandMatrix(experiment, deps)
    expect(runs).toHaveLength(8)
    expect(new Set(runs.map((r) => r.id)).size).toBe(8) // unique ids
    expect(runs.every((r) => r.status === 'queued')).toBe(true)
    expect(runs.every((r) => r.experimentId === 'exp_1')).toBe(true)
    expect(runs.every((r) => r.outputText === null && r.seedSha === null)).toBe(true)
  })

  it('freezes the prompt label and covers both repeat indices', () => {
    const runs = expandMatrix(experiment, deps)
    const cell = runs.find((r) => r.promptVersionId === 'pv_2')
    expect(cell?.promptLabel).toBe('pv_2@v1')
    const repeats = runs
      .filter((r) => r.promptVersionId === 'pv_1' && r.model === 'openai:gpt-4o')
      .map((r) => r.repeatIndex)
      .sort()
    expect(repeats).toEqual([0, 1])
  })

  it('emits in prompt-major stable order', () => {
    const runs = expandMatrix({ ...experiment, repeats: 1 }, deps)
    expect(runs.map((r) => `${r.promptVersionId}/${r.model}`)).toEqual([
      'pv_1/anthropic:claude-opus-4-8',
      'pv_1/openai:gpt-4o',
      'pv_2/anthropic:claude-opus-4-8',
      'pv_2/openai:gpt-4o',
    ])
  })
})

describe('isRunnableMatrix', () => {
  it('requires at least one of each axis', () => {
    expect(isRunnableMatrix(matrix)).toBe(true)
    expect(isRunnableMatrix({ ...matrix, models: [] })).toBe(false)
    expect(isRunnableMatrix({ ...matrix, promptVersionIds: [] })).toBe(false)
    expect(isRunnableMatrix({ ...matrix, fixtureIds: [] })).toBe(false)
  })
})
