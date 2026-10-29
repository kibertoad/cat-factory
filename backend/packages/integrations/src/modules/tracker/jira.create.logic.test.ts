import { describe, expect, it } from 'vitest'
import { buildJiraIssuePayload } from './jira.create.logic.js'

describe('buildJiraIssuePayload', () => {
  it('builds the create body with project, summary, type and ADF description', () => {
    const payload = buildJiraIssuePayload({
      projectKey: 'ENG',
      title: 'Tech debt: Auth Service',
      body: 'Refactor the session store.',
    }) as { fields: Record<string, unknown> }
    expect(payload.fields.project).toEqual({ key: 'ENG' })
    expect(payload.fields.summary).toBe('Tech debt: Auth Service')
    expect(payload.fields.issuetype).toEqual({ name: 'Task' })
    expect((payload.fields.description as { type: string }).type).toBe('doc')
  })

  it('truncates an over-long summary', () => {
    const payload = buildJiraIssuePayload({
      projectKey: 'ENG',
      title: 'x'.repeat(400),
      body: '',
    }) as { fields: { summary: string } }
    expect(payload.fields.summary.length).toBe(250)
  })
})
