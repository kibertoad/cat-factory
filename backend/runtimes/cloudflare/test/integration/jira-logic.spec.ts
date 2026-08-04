import { jiraLogic, tasksLogic } from '@cat-factory/integrations'
import { atlassianLogic } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Pure-logic unit tests for the Jira provider's source-specific helpers (ref
// parsing, ADF → Markdown), the shared Atlassian base-URL guard, and the
// task-context renderer. No worker, no network — these are the seams the real
// JiraProvider delegates to.

describe('jira logic', () => {
  it('parses an issue key from a bare key, a browse URL, and board URL forms', () => {
    expect(jiraLogic.parseJiraRef('PROJ-123')).toBe('PROJ-123')
    // case-insensitive on input, canonicalised to upper-case
    expect(jiraLogic.parseJiraRef('proj-7')).toBe('PROJ-7')
    expect(jiraLogic.parseJiraRef('https://acme.atlassian.net/browse/ABC-42')).toBe('ABC-42')
    expect(
      jiraLogic.parseJiraRef(
        'https://acme.atlassian.net/jira/software/projects/XY/boards/1?selectedIssue=XY-9',
      ),
    ).toBe('XY-9')
    expect(jiraLogic.parseJiraRef('not-an-issue')).toBeNull()
    expect(jiraLogic.parseJiraRef('123')).toBeNull()
    // A two-letter project key is the Jira minimum; a hyphenated word like
    // 'UTF-8' must not be mistaken for an issue key.
    expect(jiraLogic.parseJiraRef('UTF-8 encoding')).toBeNull()
  })

  it('converts an ADF document to lightweight Markdown', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Throttle to 100 rps.' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'text', text: 'per tenant' }] },
            { type: 'listItem', content: [{ type: 'text', text: 'burstable' }] },
          ],
        },
      ],
    }
    const md = jiraLogic.adfToMarkdown(adf)
    expect(md).toContain('## Goal')
    expect(md).toContain('Throttle to 100 rps.')
    expect(md).toContain('- per tenant')
    expect(md).toContain('- burstable')
  })

  it('renders the leaf nodes that carry their text in `attrs`, mid-sentence', () => {
    // A mention, an emoji, a status lozenge and a smart link have no children, so walking for
    // content renders them as nothing at all: a name, a state or a URL vanishing out of the middle
    // of a sentence with nothing to show it was ever there. That is a silent loss on the import
    // path and, since a tracker reply is read through this same function, a loss of the very
    // reference a human's answer was about.
    const md = jiraLogic.adfToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { id: 'acc-1', text: '@Ada' } },
            { type: 'text', text: ' about ' },
            { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/PROJ-9' } },
            { type: 'text', text: ', currently ' },
            { type: 'status', attrs: { text: 'BLOCKED' } },
            { type: 'emoji', attrs: { shortName: ':warning:' } },
          ],
        },
      ],
    })
    expect(md).toBe(
      'Ask @Ada about https://acme.atlassian.net/browse/PROJ-9, currently BLOCKED:warning:',
    )
  })

  it('handles a null or plain-string description defensively', () => {
    expect(jiraLogic.adfToMarkdown(null)).toBe('')
    expect(jiraLogic.adfToMarkdown(undefined)).toBe('')
    expect(jiraLogic.adfToMarkdown('legacy plain text')).toBe('legacy plain text')
  })

  it('rejects SSRF-prone base URLs and accepts a public https host', () => {
    expect(() =>
      atlassianLogic.assertSafeAtlassianBaseUrl('https://acme.atlassian.net'),
    ).not.toThrow()
    for (const bad of [
      'http://acme.atlassian.net',
      'https://localhost',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://10.0.0.1',
      'https://user:pass@acme.atlassian.net',
    ]) {
      expect(() => atlassianLogic.assertSafeAtlassianBaseUrl(bad), bad).toThrow()
    }
  })

  it('renders an issue into a compact context block with a metadata header', () => {
    const section = tasksLogic.renderTaskContext({
      key: 'PROJ-123',
      url: 'https://acme.atlassian.net/browse/PROJ-123',
      title: 'Add rate limiter',
      status: 'In Progress',
      type: 'Story',
      assignee: 'Jane Doe',
      priority: 'High',
      labels: ['api', 'urgent'],
      description: 'Token bucket, 100 rps per tenant.',
      comments: [{ author: 'John', createdAt: '2026-06-10T09:00:00.000Z', body: 'ship it' }],
    })
    expect(section).toContain(
      '### [PROJ-123] Add rate limiter (https://acme.atlassian.net/browse/PROJ-123)',
    )
    expect(section).toContain(
      'Status: In Progress · Type: Story · Assignee: Jane Doe · Priority: High · Labels: api, urgent',
    )
    expect(section).toContain('Token bucket, 100 rps per tenant.')
    expect(section).toContain('- John (2026-06-10): ship it')
  })
})
