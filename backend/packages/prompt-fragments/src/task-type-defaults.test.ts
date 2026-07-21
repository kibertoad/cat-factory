import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from './collections/style.js'
import {
  clearRegisteredTaskTypeDefaultFragments,
  defaultFragmentIdsForTaskType,
  registerTaskTypeDefaultFragments,
} from './task-type-defaults.js'

describe('per-task-type default fragments', () => {
  afterEach(() => clearRegisteredTaskTypeDefaultFragments())

  it('ships the document writing-style defaults as a built-in', () => {
    expect(defaultFragmentIdsForTaskType('document')).toEqual([
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
    ])
  })

  it('returns nothing for a type with no built-in and nothing registered', () => {
    expect(defaultFragmentIdsForTaskType('review')).toEqual([])
    expect(defaultFragmentIdsForTaskType('feature')).toEqual([])
  })

  it('applies deployment-registered defaults for a task type', () => {
    registerTaskTypeDefaultFragments('review', ['org.review-checklist', 'org.security'])
    expect(defaultFragmentIdsForTaskType('review')).toEqual([
      'org.review-checklist',
      'org.security',
    ])
  })

  it('unions registered document defaults with the built-in style set (deduped, built-ins first)', () => {
    const firstStyle = DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS[0] as string
    registerTaskTypeDefaultFragments('document', ['org.tone', firstStyle])
    const resolved = defaultFragmentIdsForTaskType('document')
    expect(resolved.slice(0, DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS.length)).toEqual([
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
    ])
    expect(resolved).toContain('org.tone')
    // The built-in id passed again is present exactly once.
    expect(resolved.filter((id) => id === firstStyle)).toHaveLength(1)
  })

  it('re-registering a task type replaces its registered set', () => {
    registerTaskTypeDefaultFragments('review', ['org.a'])
    registerTaskTypeDefaultFragments('review', ['org.b'])
    expect(defaultFragmentIdsForTaskType('review')).toEqual(['org.b'])
  })

  it('is unaffected by registrations after they are cleared', () => {
    registerTaskTypeDefaultFragments('review', ['org.a'])
    clearRegisteredTaskTypeDefaultFragments()
    expect(defaultFragmentIdsForTaskType('review')).toEqual([])
  })
})
