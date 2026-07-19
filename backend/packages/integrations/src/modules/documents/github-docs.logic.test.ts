import { describe, expect, it } from 'vitest'
import {
  buildGitHubCodeSearchQuery,
  describeGitHubDocFetchFailure,
  githubDocExternalId,
  githubDocTitle,
  githubDocUrl,
  githubErrorStatus,
  parseGitHubDocExternalId,
  parseGitHubDocRef,
} from './github-docs.logic.js'

describe('parseGitHubDocRef', () => {
  it('parses a blob URL, dropping the branch', () => {
    expect(
      parseGitHubDocRef('https://github.com/octo/my-repo/blob/main/docs/architecture.md'),
    ).toBe('octo/my-repo:docs/architecture.md')
  })

  it('parses a blob URL on a single-segment non-default branch', () => {
    expect(parseGitHubDocRef('https://github.com/octo/my-repo/blob/develop/docs/x.md')).toBe(
      'octo/my-repo:docs/x.md',
    )
  })

  it('mis-parses a slash-named branch (known limitation) — use the shorthand instead', () => {
    // The branch/path boundary is unrecoverable from the URL, so `feat` is taken
    // as the ref and `x/README.md` as the path. Documented in parseGitHubDocRef.
    expect(parseGitHubDocRef('https://github.com/octo/my-repo/blob/feat/x/README.md')).toBe(
      'octo/my-repo:x/README.md',
    )
    // The shorthand is unambiguous for files on such branches.
    expect(parseGitHubDocRef('octo/my-repo:README.md')).toBe('octo/my-repo:README.md')
  })

  it('parses a raw.githubusercontent URL', () => {
    expect(parseGitHubDocRef('https://raw.githubusercontent.com/octo/my-repo/main/docs/x.md')).toBe(
      'octo/my-repo:docs/x.md',
    )
  })

  it('parses the owner/repo:path shorthand', () => {
    expect(parseGitHubDocRef('octo/my-repo:docs/x.md')).toBe('octo/my-repo:docs/x.md')
  })

  it('drops a query/fragment from a URL path', () => {
    expect(parseGitHubDocRef('https://github.com/octo/my-repo/blob/main/README.md?plain=1')).toBe(
      'octo/my-repo:README.md',
    )
  })

  it('returns null for unparseable input', () => {
    expect(parseGitHubDocRef('not a ref')).toBeNull()
    expect(parseGitHubDocRef('octo/my-repo')).toBeNull()
    expect(parseGitHubDocRef('https://github.com/octo/my-repo/issues/3')).toBeNull()
  })
})

describe('parseGitHubDocExternalId', () => {
  it('round-trips a canonical external id with a nested path', () => {
    expect(parseGitHubDocExternalId('octo/my-repo:docs/a/b.md')).toEqual({
      owner: 'octo',
      repo: 'my-repo',
      path: 'docs/a/b.md',
    })
  })

  it('returns null for a malformed id', () => {
    expect(parseGitHubDocExternalId('octo/my-repo')).toBeNull()
    expect(parseGitHubDocExternalId('octo:docs/x.md')).toBeNull()
  })
})

describe('githubDocExternalId / githubDocUrl / githubDocTitle', () => {
  it('builds the canonical external id', () => {
    expect(githubDocExternalId({ owner: 'octo', repo: 'r', path: 'docs/x.md' })).toBe(
      'octo/r:docs/x.md',
    )
  })

  it('builds a HEAD blob URL', () => {
    expect(githubDocUrl({ owner: 'octo', repo: 'r', path: 'docs/x.md' })).toBe(
      'https://github.com/octo/r/blob/HEAD/docs/x.md',
    )
  })

  it('derives the file base name as the title', () => {
    expect(githubDocTitle('docs/a/architecture.md')).toBe('architecture.md')
    expect(githubDocTitle('README.md')).toBe('README.md')
  })
})

describe('githubErrorStatus', () => {
  it('reads a numeric status off an error-shaped value', () => {
    expect(githubErrorStatus({ status: 403 })).toBe(403)
    expect(githubErrorStatus(Object.assign(new Error('nope'), { status: 404 }))).toBe(404)
  })

  it('returns undefined when there is no numeric status (network fault / bare error)', () => {
    expect(githubErrorStatus(new Error('fetch failed'))).toBeUndefined()
    expect(githubErrorStatus({ status: 'oops' })).toBeUndefined()
    expect(githubErrorStatus(null)).toBeUndefined()
    expect(githubErrorStatus(undefined)).toBeUndefined()
  })
})

describe('describeGitHubDocFetchFailure', () => {
  const id = { owner: 'acme', repo: 'repo', path: 'docs/x.md' }

  it('names a permission problem for 401/403', () => {
    for (const status of [401, 403] as const) {
      const msg = describeGitHubDocFetchFailure(id, { status })
      expect(msg).toContain('docs/x.md')
      expect(msg).toContain('acme/repo')
      expect(msg).toContain(`HTTP ${status}`)
      expect(msg.toLowerCase()).toContain('read access')
    }
  })

  it('explains the default-branch/visibility cause for a not-found read', () => {
    const msg = describeGitHubDocFetchFailure(id, { notFound: true })
    expect(msg).toContain('default branch')
    expect(msg).toContain('acme/repo')
    // A 404 status is treated the same as an explicit notFound.
    expect(describeGitHubDocFetchFailure(id, { status: 404 })).toContain('default branch')
  })

  it('names a rate limit for 429', () => {
    expect(describeGitHubDocFetchFailure(id, { status: 429 })).toContain('rate-limited')
  })

  it('falls back to the underlying message + status for an unclassified failure', () => {
    const msg = describeGitHubDocFetchFailure(id, { status: 502, underlying: 'bad gateway' })
    expect(msg).toContain('HTTP 502')
    expect(msg).toContain('bad gateway')
  })
})

describe('buildGitHubCodeSearchQuery', () => {
  it('scopes an org account with the org qualifier', () => {
    expect(buildGitHubCodeSearchQuery('rate limiter', 'acme', 'Organization')).toBe(
      'rate limiter org:acme',
    )
  })

  it('scopes a user account with the user qualifier', () => {
    expect(buildGitHubCodeSearchQuery('  retry  ', 'octo', 'User')).toBe('retry user:octo')
  })
})
