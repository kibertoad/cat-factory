import { describe, expect, it } from 'vitest'
import { buildConfluenceSearchCql, parseConfluenceSearchResults } from './confluence.logic.js'
import { parseNotionSearchResults } from './notion.logic.js'

describe('buildConfluenceSearchCql', () => {
  it('builds a text-search CQL ordered by recency', () => {
    expect(buildConfluenceSearchCql('rate limiter')).toBe(
      'type = page AND text ~ "rate limiter" ORDER BY lastmodified DESC',
    )
  })

  it('escapes embedded quotes and backslashes', () => {
    expect(buildConfluenceSearchCql('say "hi"\\n')).toContain('text ~ "say \\"hi\\"\\\\n"')
  })
})

describe('parseConfluenceSearchResults', () => {
  it('maps nested-content results and resolves URLs against the response base', () => {
    const json = {
      _links: { base: 'https://team.atlassian.net/wiki' },
      results: [
        {
          content: { id: '123', title: 'Spec', type: 'page' },
          _links: { webui: '/pages/123/Spec' },
        },
      ],
    }
    expect(parseConfluenceSearchResults(json, 'https://team.atlassian.net')).toEqual([
      {
        source: 'confluence',
        externalId: '123',
        title: 'Spec',
        url: 'https://team.atlassian.net/wiki/pages/123/Spec',
        excerpt: '',
      },
    ])
  })

  it('falls back to the site base and a pages URL when links are absent', () => {
    const json = { results: [{ id: '9', title: 'Flat' }] }
    expect(parseConfluenceSearchResults(json, 'https://team.atlassian.net/')).toEqual([
      {
        source: 'confluence',
        externalId: '9',
        title: 'Flat',
        url: 'https://team.atlassian.net/wiki/pages/9',
        excerpt: '',
      },
    ])
  })

  it('skips rows without an id and tolerates a non-object body', () => {
    expect(parseConfluenceSearchResults({ results: [{ title: 'no id' }] }, 'x')).toEqual([])
    expect(parseConfluenceSearchResults(null, 'x')).toEqual([])
  })
})

describe('parseNotionSearchResults', () => {
  it('maps page results and dashes the id', () => {
    const json = {
      results: [
        {
          object: 'page',
          id: '11111111111111111111111111111111',
          url: 'https://notion.so/Title-1111',
          properties: { Name: { type: 'title', title: [{ plain_text: 'My Page' }] } },
        },
      ],
    }
    expect(parseNotionSearchResults(json)).toEqual([
      {
        source: 'notion',
        externalId: '11111111-1111-1111-1111-111111111111',
        title: 'My Page',
        url: 'https://notion.so/Title-1111',
        excerpt: '',
      },
    ])
  })

  it('filters out non-page objects (databases)', () => {
    const json = { results: [{ object: 'database', id: 'abc' }] }
    expect(parseNotionSearchResults(json)).toEqual([])
  })
})
