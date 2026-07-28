import { describe, expect, it } from 'vitest'
import { normalizeRepoSearchQuery, parseOwnerRepoSlug, parseRepoWebUrl } from './repo-url.js'

describe('parseRepoWebUrl', () => {
  it('parses a bare repo URL as the root directory', () => {
    expect(parseRepoWebUrl('https://github.com/octo/repo')).toEqual({
      owner: 'octo',
      repo: 'repo',
      path: '',
      kind: 'dir',
    })
  })

  it('parses a tree (directory) URL', () => {
    expect(parseRepoWebUrl('https://github.com/octo/repo/tree/main/docs/adr')).toEqual({
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      path: 'docs/adr',
      kind: 'dir',
    })
  })

  it('parses a blob (file) URL and strips query/hash', () => {
    expect(parseRepoWebUrl('https://github.com/octo/repo/blob/main/README.md?plain=1#L10')).toEqual(
      { owner: 'octo', repo: 'repo', ref: 'main', path: 'README.md', kind: 'file' },
    )
  })

  it('parses a raw.githubusercontent.com URL as a file', () => {
    expect(parseRepoWebUrl('https://raw.githubusercontent.com/octo/repo/main/docs/x.md')).toEqual({
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      path: 'docs/x.md',
      kind: 'file',
    })
  })

  it('parses the GitLab /-/ form, keeping a subgroup namespace intact', () => {
    expect(parseRepoWebUrl('https://gitlab.com/group/subgroup/project/-/tree/main/docs')).toEqual({
      owner: 'group/subgroup',
      repo: 'project',
      ref: 'main',
      path: 'docs',
      kind: 'dir',
    })
  })

  it('accepts a scheme-less paste and a trailing .git', () => {
    expect(parseRepoWebUrl('github.com/octo/repo.git')).toEqual({
      owner: 'octo',
      repo: 'repo',
      path: '',
      kind: 'dir',
    })
  })

  it('accepts a tree URL with no path (the ref root)', () => {
    expect(parseRepoWebUrl('https://github.com/octo/repo/tree/main')).toEqual({
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      path: '',
      kind: 'dir',
    })
  })

  it.each([
    'not a url at all',
    'octo/repo', // a slug, not a URL — the picker treats it as a plain query
    'https://github.com/octo', // no repo segment
    'https://github.com/octo/repo/pulls/123', // not a tree/blob marker
  ])('returns null for %j', (input) => {
    expect(parseRepoWebUrl(input)).toBeNull()
  })
})

describe('normalizeRepoSearchQuery', () => {
  it('collapses a pasted URL to its owner/repo slug', () => {
    expect(normalizeRepoSearchQuery('https://github.com/octo/repo/tree/main/docs')).toBe(
      'octo/repo',
    )
  })

  it('passes a non-URL query through unchanged', () => {
    expect(normalizeRepoSearchQuery('board')).toBe('board')
  })
})

describe('parseOwnerRepoSlug', () => {
  it('splits an exact owner/name slug', () => {
    expect(parseOwnerRepoSlug(' octo/repo ')).toEqual({ owner: 'octo', repo: 'repo' })
  })

  it.each(['octo', 'octo/repo/extra', 'octo/re po', ''])('returns null for %j', (input) => {
    expect(parseOwnerRepoSlug(input)).toBeNull()
  })
})
