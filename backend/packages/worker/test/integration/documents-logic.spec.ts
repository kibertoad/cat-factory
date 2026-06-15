import { confluenceLogic, notionLogic, documentsLogic } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'

// Pure-logic unit tests for the document-source providers' source-specific
// helpers and the shared planner. No worker, no network — these are the seams
// the real providers delegate to.

describe('confluence logic', () => {
  it('parses a page id from a bare id, a modern URL, and a legacy URL', () => {
    expect(confluenceLogic.parseConfluenceRef('12345')).toBe('12345')
    expect(
      confluenceLogic.parseConfluenceRef(
        'https://acme.atlassian.net/wiki/spaces/ENG/pages/98765/Some+Title',
      ),
    ).toBe('98765')
    expect(confluenceLogic.parseConfluenceRef('https://acme.atlassian.net/wiki/x?pageId=555')).toBe(
      '555',
    )
    expect(confluenceLogic.parseConfluenceRef('not-a-page')).toBeNull()
  })

  it('normalizes a trailing /wiki and slash', () => {
    expect(confluenceLogic.normalizeBaseUrl('https://acme.atlassian.net/wiki/')).toBe(
      'https://acme.atlassian.net',
    )
  })

  it('rejects SSRF-prone base URLs and accepts a public https host', () => {
    expect(() =>
      confluenceLogic.assertSafeConfluenceBaseUrl('https://acme.atlassian.net'),
    ).not.toThrow()
    for (const bad of [
      'http://acme.atlassian.net', // not https
      'https://localhost', // loopback host
      'https://169.254.169.254', // cloud metadata / link-local
      'https://192.168.0.10', // RFC1918 private
      'https://10.1.2.3', // RFC1918 private
      'https://user:pass@acme.atlassian.net', // embedded credentials
    ]) {
      expect(() => confluenceLogic.assertSafeConfluenceBaseUrl(bad), bad).toThrow()
    }
  })

  it('converts storage-format XHTML headings/lists to Markdown', () => {
    const md = confluenceLogic.confluenceStorageToMarkdown(
      '<h1>Billing</h1><h2>Invoices</h2><ul><li>Create</li><li>Void</li></ul><p>Notes &amp; more</p>',
    )
    expect(md).toContain('# Billing')
    expect(md).toContain('## Invoices')
    expect(md).toContain('- Create')
    expect(md).toContain('Notes & more')
  })
})

describe('notion logic', () => {
  it('parses a page id from a dashed UUID, a bare 32-hex id, and a slug URL', () => {
    const dashed = '12345678-90ab-cdef-1234-567890abcdef'
    expect(notionLogic.parseNotionRef(dashed)).toBe(dashed)
    expect(notionLogic.parseNotionRef('1234567890abcdef1234567890abcdef')).toBe(dashed)
    expect(
      notionLogic.parseNotionRef(
        'https://www.notion.so/My-Page-1234567890abcdef1234567890abcdef?v=x',
      ),
    ).toBe(dashed)
    expect(notionLogic.parseNotionRef('nope')).toBeNull()
  })

  it('converts blocks to Markdown headings/list items', () => {
    const md = notionLogic.notionBlocksToMarkdown([
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Billing' }] } },
      { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Invoices' }] } },
      { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Create' }] } },
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Notes here' }] } },
    ])
    expect(md).toBe('# Billing\n## Invoices\n- Create\nNotes here')
  })

  it('extracts a page title from properties', () => {
    expect(
      notionLogic.notionPageTitle({
        Name: { type: 'title', title: [{ plain_text: 'Rate Limiter RFC' }] },
      }),
    ).toBe('Rate Limiter RFC')
    expect(notionLogic.notionPageTitle(undefined)).toBe('(untitled)')
  })
})

describe('shared planner', () => {
  it('maps a Markdown heading outline onto frames/modules/tasks', () => {
    const plan = documentsLogic.planFromHeadings(
      'notion',
      'p1',
      'Doc',
      '# Service\n## Module A\n### Task 1\n### Task 2\n## Module B',
    )
    expect(plan.source).toBe('notion')
    expect(plan.planner).toBe('headings')
    expect(plan.frames).toHaveLength(1)
    expect(plan.frames[0]!.modules.map((m) => m.name)).toEqual(['Module A', 'Module B'])
    expect(plan.frames[0]!.modules[0]!.tasks.map((t) => t.title)).toEqual(['Task 1', 'Task 2'])
  })

  it('coerces an LLM JSON plan and drops malformed entries', () => {
    const plan = documentsLogic.coercePlan('confluence', 'p2', {
      frames: [
        { type: 'api', title: 'Gateway', modules: [], tasks: [{ title: 'Route' }, { bad: true }] },
        { title: '' },
      ],
    })
    expect(plan).not.toBeNull()
    expect(plan!.planner).toBe('llm')
    expect(plan!.frames).toHaveLength(1)
    expect(plan!.frames[0]!.type).toBe('api')
    expect(plan!.frames[0]!.tasks.map((t) => t.title)).toEqual(['Route'])
  })
})
