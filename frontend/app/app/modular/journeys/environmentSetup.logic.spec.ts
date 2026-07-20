import { describe, expect, it } from 'vitest'
import { resolveStepSequence } from '@modular-vue/journeys'
import {
  ENV_MODULE_ID,
  environmentSetupJourney,
  envInitialState,
  envStartStep,
} from './environmentSetup.logic'

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
})
