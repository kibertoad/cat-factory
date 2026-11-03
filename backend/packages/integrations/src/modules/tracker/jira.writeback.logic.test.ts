import { describe, expect, it } from 'vitest'
import {
  buildJiraCommentPayload,
  JIRA_FIELD_MAX_CHARS,
  JIRA_TRUNCATION_NOTE,
  pickTransitionByCategory,
} from './jira.writeback.logic.js'

describe('buildJiraCommentPayload', () => {
  it('wraps a Markdown comment body in an ADF document', () => {
    const payload = buildJiraCommentPayload('PR merged: https://example.test/pr/1') as {
      body: { type: string; content: unknown[] }
    }
    expect(payload.body.type).toBe('doc')
    expect(payload.body.content.length).toBeGreaterThan(0)
  })

  it("keeps the stored ADF under Jira's field limit, marking the cut", () => {
    const markdown = Array.from({ length: 3_000 }, (_, i) => `- item ${i}`).join('\n')
    const { body } = buildJiraCommentPayload(markdown)
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(JIRA_FIELD_MAX_CHARS)
    expect(JSON.stringify(body.content.at(-1))).toContain(JIRA_TRUNCATION_NOTE)
  })
})

describe('pickTransitionByCategory', () => {
  it('picks the first transition whose target status is in the Done category', () => {
    const transition = pickTransitionByCategory(
      [
        { id: '11', name: 'Start Progress', to: { statusCategory: { key: 'indeterminate' } } },
        { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
        { id: '41', name: 'Closed', to: { statusCategory: { key: 'done' } } },
      ],
      'done',
    )
    expect(transition?.id).toBe('31')
  })

  it('picks the first transition into the In Progress (indeterminate) category', () => {
    const transition = pickTransitionByCategory(
      [
        { id: '21', name: 'Back to To Do', to: { statusCategory: { key: 'new' } } },
        { id: '11', name: 'Start Progress', to: { statusCategory: { key: 'indeterminate' } } },
        { id: '12', name: 'In Review', to: { statusCategory: { key: 'indeterminate' } } },
        { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
      ],
      'indeterminate',
    )
    expect(transition?.id).toBe('11')
  })

  it('returns null when no transition resolves to the requested category', () => {
    expect(
      pickTransitionByCategory(
        [
          { id: '11', name: 'Start Progress', to: { statusCategory: { key: 'indeterminate' } } },
          { id: '21', name: 'Back to To Do', to: { statusCategory: { key: 'new' } } },
        ],
        'done',
      ),
    ).toBeNull()
  })

  it('ignores a matching transition with no id (cannot be executed)', () => {
    expect(
      pickTransitionByCategory([{ name: 'Done', to: { statusCategory: { key: 'done' } } }], 'done'),
    ).toBeNull()
  })

  it('returns null for an empty transition list', () => {
    expect(pickTransitionByCategory([], 'done')).toBeNull()
    expect(pickTransitionByCategory([], 'indeterminate')).toBeNull()
  })
})
