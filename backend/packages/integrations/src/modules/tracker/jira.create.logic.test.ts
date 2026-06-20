import { describe, expect, it } from 'vitest'
import { buildJiraIssuePayload, markdownToAdf } from './jira.create.logic.js'
import { toBase64 } from './base64.js'

describe('markdownToAdf', () => {
  it('maps headings, paragraphs and bullet lists', () => {
    const doc = markdownToAdf('# Title\n\nSome prose.\n\n- one\n- two')
    expect(doc.type).toBe('doc')
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(doc.content[1]).toMatchObject({ type: 'paragraph' })
    expect(doc.content[2]).toMatchObject({ type: 'bulletList' })
    expect(doc.content[2]!.content).toHaveLength(2)
  })

  it('never yields empty content (ADF requires non-empty)', () => {
    expect(markdownToAdf('').content).toHaveLength(1)
  })
})

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

describe('toBase64', () => {
  it('encodes ASCII credentials like btoa', () => {
    expect(toBase64('user@example.com:token123')).toBe('dXNlckBleGFtcGxlLmNvbTp0b2tlbjEyMw==')
    expect(toBase64('a')).toBe('YQ==')
    expect(toBase64('ab')).toBe('YWI=')
    expect(toBase64('abc')).toBe('YWJj')
  })
})
