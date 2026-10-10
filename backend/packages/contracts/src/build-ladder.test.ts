import { describe, expect, it } from 'vitest'
import {
  ADAPTIVE_BUILD_PIPELINE_ID,
  BUILD_PIPELINE_ID,
  declaredDefaultPipelineId,
  defaultBuildPipelineId,
  UNATTENDED_BUILD_PIPELINE_ID,
} from './build-ladder.js'

// The default-pipeline rule, stated here because BOTH the SPA's start controls and the engine's
// headless start fall back through it: two readings of "the default" is how a Start button comes to
// run something other than what the board said it would.

const row = (id: string, claims: { isDefault?: boolean; isUnattendedDefault?: boolean } = {}) => ({
  id,
  ...claims,
})

describe('declaredDefaultPipelineId', () => {
  it('reads the row claiming the scope', () => {
    const library = [
      row(BUILD_PIPELINE_ID, { isDefault: true }),
      row(UNATTENDED_BUILD_PIPELINE_ID, { isUnattendedDefault: true }),
    ]
    expect(declaredDefaultPipelineId(library, 'interactive')).toBe(BUILD_PIPELINE_ID)
    expect(declaredDefaultPipelineId(library, 'unattended')).toBe(UNATTENDED_BUILD_PIPELINE_ID)
  })

  it('lets ONE row hold both scopes', () => {
    const library = [row('pl_one', { isDefault: true, isUnattendedDefault: true })]
    expect(declaredDefaultPipelineId(library, 'interactive')).toBe('pl_one')
    expect(declaredDefaultPipelineId(library, 'unattended')).toBe('pl_one')
  })

  // Undefined is a real answer, not a lookup failure: the interactive scope is deliberately
  // unseeded, so "nobody has stated one" is the normal state and each caller composes its own
  // fallback with it.
  it('answers undefined when no row claims the scope', () => {
    const library = [row(BUILD_PIPELINE_ID), row(ADAPTIVE_BUILD_PIPELINE_ID)]
    expect(declaredDefaultPipelineId(library, 'interactive')).toBeUndefined()
    expect(declaredDefaultPipelineId(library, 'unattended')).toBeUndefined()
    expect(declaredDefaultPipelineId([], 'unattended')).toBeUndefined()
  })

  // An explicit `false` is a release, and reads exactly like an absent flag. Nothing distinguishes
  // "released" from "never claimed" at this layer on purpose: what the operator wants in both cases
  // is the scope's own fallback.
  it('reads an explicitly released claim as no claim', () => {
    const library = [row(BUILD_PIPELINE_ID, { isDefault: false })]
    expect(declaredDefaultPipelineId(library, 'interactive')).toBeUndefined()
  })
})

describe('defaultBuildPipelineId', () => {
  it('is the fixed rung in basic mode and the adaptive one in advanced', () => {
    expect(defaultBuildPipelineId(false)).toBe(BUILD_PIPELINE_ID)
    expect(defaultBuildPipelineId(true)).toBe(ADAPTIVE_BUILD_PIPELINE_ID)
  })
})
