import { describe, expect, it } from 'vitest'
import { describeVcsApiError } from './vcs-errors.js'

const base = { method: 'GET', url: 'https://api.github.com/repos/o/r', body: 'nope' }

describe('describeVcsApiError', () => {
  it('preserves the raw status line as the first line (kept for detail + greps)', () => {
    const msg = describeVcsApiError({ provider: 'github', status: 401, ...base })
    expect(msg.split('\n')[0]).toBe('GitHub GET https://api.github.com/repos/o/r → 401: nope')
  })

  it('omits the body segment when there is none', () => {
    const msg = describeVcsApiError({ provider: 'gitlab', status: 500, method: 'POST', url: 'x' })
    expect(msg.split('\n')[0]).toBe('GitLab POST x → 500')
  })

  it('GitHub 401 → token-rejected remedy pointing at the App reconnect + PAT + docs', () => {
    const msg = describeVcsApiError({ provider: 'github', status: 401, ...base })
    expect(msg).toContain('token was rejected')
    expect(msg).toContain('reconnect the GitHub App')
    expect(msg).toContain('GITHUB_PAT')
    expect(msg).toContain('backend/docs/github-operations.md')
  })

  it('GitHub 403 with rate-limit exhausted → rate-limit remedy naming the reset time', () => {
    const resetAt = Date.UTC(2026, 0, 2, 3, 4, 5)
    const msg = describeVcsApiError({
      provider: 'github',
      status: 403,
      ...base,
      rateLimited: true,
      resetAt,
    })
    expect(msg).toContain('rate limit was exceeded')
    expect(msg).toContain(new Date(resetAt).toISOString())
    expect(msg).not.toContain('lacks a required permission')
  })

  it('GitHub 403 without rate-limit → missing-scope remedy', () => {
    const msg = describeVcsApiError({ provider: 'github', status: 403, ...base })
    expect(msg).toContain('lacks a required permission or scope')
    expect(msg).not.toContain('rate limit')
  })

  it('GitHub 429 is treated as a rate limit', () => {
    const msg = describeVcsApiError({ provider: 'github', status: 429, ...base })
    expect(msg).toContain('rate limit was exceeded')
  })

  it('GitHub 404 → not-visible-to-token remedy linking the integration doc', () => {
    const msg = describeVcsApiError({ provider: 'github', status: 404, ...base })
    expect(msg).toContain('not visible to this token')
    expect(msg).toContain('backend/docs/github-integration.md')
  })

  it('GitLab remedies are GitLab-flavoured (api scope, Developer/Maintainer role, vcs doc)', () => {
    expect(describeVcsApiError({ provider: 'gitlab', status: 401, ...base })).toContain(
      '`api` scope',
    )
    const forbidden = describeVcsApiError({ provider: 'gitlab', status: 403, ...base })
    expect(forbidden).toContain('Developer or Maintainer role')
    expect(forbidden).toContain('backend/docs/vcs-providers.md')
  })

  it('leaves an unmapped status (e.g. 422) as the raw line only', () => {
    const msg = describeVcsApiError({ provider: 'github', status: 422, ...base })
    expect(msg).toBe('GitHub GET https://api.github.com/repos/o/r → 422: nope')
    expect(msg).not.toContain('\n')
  })
})
