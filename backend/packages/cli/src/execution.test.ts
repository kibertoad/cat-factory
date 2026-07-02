import { MODEL_CATALOG, SUBSCRIPTION_VENDORS } from '@cat-factory/kernel'
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

// NATIVE_MODELS is a hand-maintained mirror of the backend catalog (the CLI stays runtime
// dependency-free, so it can't import it at runtime). These couple the mirror to the real
// `@cat-factory/kernel` catalog as a DEV-only import, so a flagship-model rename / relabel /
// harness change breaks this test instead of silently shipping a wrong `.env` comment.
describe('NATIVE_MODELS mirror is in step with the backend catalog', () => {
  it('names a real catalog model (id + label) for every native entry', () => {
    for (const m of NATIVE_MODELS) {
      const model = MODEL_CATALOG.find((c) => c.id === m.id)
      expect(model, `native model id "${m.id}" is missing from MODEL_CATALOG`).toBeDefined()
      expect(model?.label, `label drift for "${m.id}"`).toBe(m.label)
    }
  })

  it('maps each native entry to the harness its catalog subscription vendor uses', () => {
    for (const m of NATIVE_MODELS) {
      const model = MODEL_CATALOG.find((c) => c.id === m.id)
      const vendor = model?.subscription?.vendor
      expect(vendor, `"${m.id}" has no subscription vendor in the catalog`).toBeDefined()
      const cfg = vendor ? SUBSCRIPTION_VENDORS[vendor] : undefined
      expect(cfg?.harness, `harness drift for "${m.id}"`).toBe(m.harness)
      // Only a TRUE native vendor (its own CLI login, no Anthropic-compatible baseUrl) runs
      // natively; a harness-reusing vendor (GLM/Kimi/DeepSeek carries a baseUrl) must not leak in.
      expect(cfg?.baseUrl, `"${m.id}" mirrors a non-native (baseUrl) vendor`).toBeUndefined()
    }
  })
})

describe('EXECUTION_MODE_TRADEOFFS', () => {
  it('describes both modes so the picker can show them', () => {
    expect(EXECUTION_MODE_TRADEOFFS.pool.join('\n')).toMatch(/Isolated/i)
    expect(EXECUTION_MODE_TRADEOFFS.native.join('\n')).toMatch(/no sandbox/i)
  })
})
