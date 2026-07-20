import { describe, expect, it } from 'vitest'
import { resolveStepSequence } from '@modular-vue/journeys'
import {
  ENV_MODULE_ID,
  environmentSetupJourney,
  envInitialState,
  envStartStep,
} from './environmentSetup.logic'
import en from '../../../i18n/locales/en.json'

/** Dot-path lookup into the real `en.json`, mirroring which keys actually ship. */
function hasKey(path: string): boolean {
  return (
    path.split('.').reduce<unknown>((node, seg) => {
      return node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined
    }, en) !== undefined
  )
}

// Pure navigation graph for the environment-setup journey (slice 3). The step
// order is derived from the annotated transition graph (production-feedback item
// 4), so `resolveStepSequenceResult` walking the real journey definition is the
// guard against a silent reorder or dropped step — no hand-maintained order array
// to pin separately.
describe('environment-setup journey logic', () => {
  it('seeds state from the launch input', () => {
    expect(envInitialState({ frameId: 'blk_1' })).toEqual({ frameId: 'blk_1' })
    expect(envInitialState({ frameId: null })).toEqual({ frameId: null })
  })

  it('skips the picker when a frame was preselected, else starts at pick', () => {
    expect(envStartStep({ frameId: 'blk_1' }, { frameId: 'blk_1' })).toBe('review')
    expect(envStartStep({ frameId: null }, { frameId: null })).toBe('pick')
  })

  it('derives the pick → review → preflight → save order from the transition graph', () => {
    const steps = resolveStepSequence(environmentSetupJourney, { input: { frameId: null } })
    expect(steps.map((s) => s.entry)).toEqual(['pick', 'review', 'preflight', 'save'])
    expect(steps.every((s) => s.module === ENV_MODULE_ID)).toBe(true)
    expect(steps.map((s) => s.progressLabel)).toEqual([
      'environmentWizard.steps.pick',
      'environmentWizard.steps.review',
      'environmentWizard.steps.preflight',
      'environmentWizard.steps.save',
    ])
  })

  it('starts the derived sequence at review when a frame is preselected', () => {
    const steps = resolveStepSequence(environmentSetupJourney, { input: { frameId: 'blk_1' } })
    expect(steps.map((s) => s.entry)).toEqual(['review', 'preflight', 'save'])
  })

  // The stepper resolves each label through a VARIABLE key (`t(step.progressLabel)`), so
  // the tier-1 typed-message-keys check + `vue-i18n-extract` can no longer see these keys
  // as used and can't catch a typo or a dropped key. Pin the missing-key guard here instead:
  // every `progressLabel` the real definition emits must resolve to a shipping `en.json` key.
  it('carries a shipping en.json label key for every derived step', () => {
    const steps = resolveStepSequence(environmentSetupJourney, { input: { frameId: null } })
    for (const step of steps) {
      const key = step.progressLabel
      expect(key, `missing i18n key for step "${step.entry}"`).toBeTruthy()
      expect(hasKey(key ?? ''), `key "${key}" not in en.json`).toBe(true)
    }
  })
})
