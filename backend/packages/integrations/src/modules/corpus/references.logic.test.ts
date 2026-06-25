import { describe, expect, it } from 'vitest'
import { extractReferences } from './references.logic.js'

describe('extractReferences', () => {
  it('returns empty lists for empty input', () => {
    expect(extractReferences('')).toEqual({ jiraKeys: [], githubRefs: [], urls: [] })
  })

  it('extracts Jira keys and dedupes', () => {
    const text = 'Implements PROJ-123 and relates to PROJ-123, blocked by ABC-9.'
    expect(extractReferences(text).jiraKeys).toEqual(['PROJ-123', 'ABC-9'])
  })

  it('extracts bare and cross-repo GitHub refs, stripping the leading #', () => {
    const text = 'Fixes #42 and depends on octo/repo#7.'
    expect(extractReferences(text).githubRefs).toEqual(['42', 'octo/repo#7'])
  })

  it('extracts URLs and trims trailing punctuation', () => {
    const text = 'See https://acme.atlassian.net/wiki/x and https://github.com/o/r/issues/1.'
    expect(extractReferences(text).urls).toEqual([
      'https://acme.atlassian.net/wiki/x',
      'https://github.com/o/r/issues/1',
    ])
  })

  it('does not crash on prose with no references', () => {
    expect(extractReferences('Just some plain text.')).toEqual({
      jiraKeys: [],
      githubRefs: [],
      urls: [],
    })
  })
})
