import { describe, expect, it } from 'vitest'
import {
  EXECUTION_MODE_TRADEOFFS,
  NATIVE_MODELS,
  nativeModelSummary,
  nativeModelsFor,
} from './execution.js'

describe('nativeModelsFor', () => {
  it('returns only the models served by the enabled harnesses', () => {
    expect(nativeModelsFor(['claude-code']).every((m) => m.harness === 'claude-code')).toBe(true)
    expect(nativeModelsFor(['codex']).every((m) => m.harness === 'codex')).toBe(true)
  })

  it('returns every native model when both harnesses are enabled', () => {
    expect(nativeModelsFor(['claude-code', 'codex'])).toEqual(NATIVE_MODELS)
  })

  it('returns nothing for an empty harness set', () => {
    expect(nativeModelsFor([])).toEqual([])
  })
})

describe('nativeModelSummary', () => {
  it('renders a "Label (id)" list for the enabled harnesses', () => {
    const summary = nativeModelSummary(['codex'])
    expect(summary).toContain('GPT-5.5 (gpt-5.5)')
    expect(summary).not.toContain('claude-opus')
  })

  it('reads "none" when no model applies', () => {
    expect(nativeModelSummary([])).toBe('none')
  })
})

describe('EXECUTION_MODE_TRADEOFFS', () => {
  it('describes both modes so the picker can show them', () => {
    expect(EXECUTION_MODE_TRADEOFFS.pool.join('\n')).toMatch(/Isolated/i)
    expect(EXECUTION_MODE_TRADEOFFS.native.join('\n')).toMatch(/no sandbox/i)
  })
})
