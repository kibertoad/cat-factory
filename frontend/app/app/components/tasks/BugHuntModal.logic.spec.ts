import { describe, expect, it } from 'vitest'
import type { TaskSourceState } from '@cat-factory/contracts'
import { boardFromService, huntRequest } from './BugHuntModal.logic'

// What scopes a hunt. The rule is small and the failures are silent in both directions: a
// repo-backed tracker that sends a board would be refused on submit, and one that sent an empty
// string instead of an explicit null would read as a board named as blank.

function state(overrides: Partial<TaskSourceState> = {}): TaskSourceState {
  return {
    source: 'github',
    label: 'GitHub Issues',
    icon: 'i-lucide-github',
    credentialFields: [],
    refLabel: 'Issue URL',
    refPlaceholder: 'acme/web#123',
    available: true,
    enabled: true,
    ridesVcsProvider: 'github',
    supportsIntake: true,
    ignoredIntakePredicates: [],
    repoBacked: true,
    ...overrides,
  }
}

const FORM = { containerId: 'blk-1', board: '', issueType: '', labels: '' }

describe('boardFromService', () => {
  it('follows what the SOURCE declares, not which source it is', () => {
    expect(boardFromService(state({ source: 'acme:forge' }))).toBe(true)
    expect(boardFromService(state({ source: 'jira', repoBacked: false }))).toBe(false)
  })

  it('treats an unresolved source as having a board, so a control is still rendered', () => {
    expect(boardFromService(undefined)).toBe(false)
  })
})

describe('huntRequest', () => {
  it('sends an explicit null board for a repo-backed tracker, whatever was typed before', () => {
    const request = huntRequest({ ...FORM, source: state(), board: 'someone-else/web' })

    // Null, never '' and never the stale text: the backend REFUSES a board named for such a
    // source, so a hunt that carried one would be rejected rather than scoped.
    expect(request).toEqual({ containerId: 'blk-1', board: null })
  })

  it('sends the trimmed board a repo-less tracker names', () => {
    const source = state({ source: 'jira', repoBacked: false })

    expect(huntRequest({ ...FORM, source, board: '  PROJ  ' })).toEqual({
      containerId: 'blk-1',
      board: 'PROJ',
    })
  })

  it('describes no scan until a repo-less tracker has a board', () => {
    const source = state({ source: 'jira', repoBacked: false })

    expect(huntRequest({ ...FORM, source, board: '   ' })).toBeNull()
  })

  it('describes no scan without a container, which decides the repository too', () => {
    expect(huntRequest({ ...FORM, source: state(), containerId: undefined })).toBeNull()
  })

  it('carries only the predicates that were actually filled in', () => {
    const request = huntRequest({
      ...FORM,
      source: state(),
      issueType: ' defect ',
      labels: 'regression, , checkout ',
    })

    expect(request).toEqual({
      containerId: 'blk-1',
      board: null,
      issueType: 'defect',
      labels: ['regression', 'checkout'],
    })
  })
})
