import { describe, expect, it } from 'vitest'
import {
  ENV_STEP_ORDER,
  envInitialState,
  envNextAfter,
  envStartStep,
} from './environmentSetup.logic'

// Pure navigation graph for the environment-setup journey (slice 3). `envNextAfter`
// is the source of truth the journey's `advance` transitions derive their target
// entries from (see `environmentSetup.ts`), so pinning the order, start branch, and
// forward edges here means a wiring regression can't silently reorder or drop a step.
describe('environment-setup journey logic', () => {
  it('orders the steps pick → review → preflight → save', () => {
    expect(ENV_STEP_ORDER).toEqual(['pick', 'review', 'preflight', 'save'])
  })

  it('seeds state from the launch input', () => {
    expect(envInitialState({ frameId: 'blk_1' })).toEqual({ frameId: 'blk_1' })
    expect(envInitialState({ frameId: null })).toEqual({ frameId: null })
  })

  it('skips the picker when a frame was preselected, else starts at pick', () => {
    expect(envStartStep({ frameId: 'blk_1' }, { frameId: 'blk_1' })).toBe('review')
    expect(envStartStep({ frameId: null }, { frameId: null })).toBe('pick')
  })

  it('advances linearly and terminates after save', () => {
    expect(envNextAfter('pick')).toBe('review')
    expect(envNextAfter('review')).toBe('preflight')
    expect(envNextAfter('preflight')).toBe('save')
    expect(envNextAfter('save')).toBe('done')
  })
})
