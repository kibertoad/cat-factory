import { describe, expect, it } from 'vitest'
import { buildJiraCommentPayload, pickDoneTransition } from './jira.writeback.logic.js'

describe('buildJiraCommentPayload', () => {
  it('wraps a Markdown comment body in an ADF document', () => {
    const payload = buildJiraCommentPayload('PR merged: https://example.test/pr/1') as {
      body: { type: string; content: unknown[] }
    }
    expect(payload.body.type).toBe('doc')
    expect(payload.body.content.length).toBeGreaterThan(0)
  })
})

describe('pickDoneTransition', () => {
  it('picks the first transition whose target status is in the Done category', () => {
    const transition = pickDoneTransition([
      { id: '11', name: 'Start Progress', to: { statusCategory: { key: 'indeterminate' } } },
      { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
      { id: '41', name: 'Closed', to: { statusCategory: { key: 'done' } } },
    ])
    expect(transition?.id).toBe('31')
  })

  it('returns null when no transition resolves to a Done status', () => {
    expect(
      pickDoneTransition([
        { id: '11', name: 'Start Progress', to: { statusCategory: { key: 'indeterminate' } } },
        { id: '21', name: 'Back to To Do', to: { statusCategory: { key: 'new' } } },
      ]),
    ).toBeNull()
  })

  it('ignores a Done transition with no id (cannot be executed)', () => {
    expect(
      pickDoneTransition([{ name: 'Done', to: { statusCategory: { key: 'done' } } }]),
    ).toBeNull()
  })

  it('returns null for an empty transition list', () => {
    expect(pickDoneTransition([])).toBeNull()
  })
})
