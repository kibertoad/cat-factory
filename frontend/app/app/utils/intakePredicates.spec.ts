import { describe, expect, it } from 'vitest'
import type { TaskSourceState } from '@cat-factory/contracts'
import { appliesIntakePredicate } from './intakePredicates'

function state(ignored: TaskSourceState['ignoredIntakePredicates']): TaskSourceState {
  return {
    source: 'gitlab',
    label: 'GitLab Issues',
    icon: 'i-lucide-gitlab',
    credentialFields: [],
    refLabel: 'Issue URL',
    refPlaceholder: 'acme/web#123',
    available: true,
    enabled: true,
    ridesVcsProvider: 'gitlab',
    supportsIntake: true,
    repoBacked: true,
    ignoredIntakePredicates: ignored,
  }
}

describe('appliesIntakePredicate', () => {
  it('applies a predicate the source did not name', () => {
    expect(appliesIntakePredicate(state(['issueType']), 'labels')).toBe(true)
  })

  it('withholds the one it did', () => {
    expect(appliesIntakePredicate(state(['issueType']), 'issueType')).toBe(false)
  })

  // An unresolved source is not a source with a known gap. Answering `false` here would put a
  // warning under every freshly-opened form, before anything has been picked to warn about.
  it('treats an unresolved source as applying everything', () => {
    expect(appliesIntakePredicate(undefined, 'issueType')).toBe(true)
  })

  // A state from an older backend carries no array at all; a missing declaration is the same
  // claim as an empty one ("this source applies them all"), not a reason to render nothing.
  it('treats a missing declaration as applying everything', () => {
    const legacy = { ...state([]) } as Partial<TaskSourceState>
    delete legacy.ignoredIntakePredicates
    expect(appliesIntakePredicate(legacy as TaskSourceState, 'issueType')).toBe(true)
  })
})
