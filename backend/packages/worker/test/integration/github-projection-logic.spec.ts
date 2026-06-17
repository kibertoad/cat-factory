import { githubProjection as gp } from '@cat-factory/integrations'
import { describe, expect, it } from 'vitest'

// Pure-function unit tests for the shared GitHub-JSON → projection mappers. No
// I/O; they pin down the mapping edge cases the higher-level sync/webhook tests
// don't assert precisely.

describe('projection.logic mappers', () => {
  it('parses ISO timestamps and rejects invalid ones', () => {
    expect(gp.isoToEpochMs('2026-06-01T00:00:00Z')).toBe(Date.parse('2026-06-01T00:00:00Z'))
    expect(gp.isoToEpochMs('not-a-date')).toBeNull()
    expect(gp.isoToEpochMs(undefined)).toBeNull()
    expect(gp.isoToEpochMs(12345)).toBeNull()
  })

  it('maps a repo payload, defaulting missing fields', () => {
    const repo = gp.toRepoProjection({ id: 9, name: 'web', owner: { login: 'acme' } }, 42, 1000)
    expect(repo).toMatchObject({
      githubId: 9,
      name: 'web',
      owner: 'acme',
      installationId: 42,
      private: false,
      defaultBranch: null,
      blockId: null,
      syncedAt: 1000,
    })
  })

  it('detects merged PRs via merged or merged_at, and resolves repo id from base', () => {
    const base = {
      id: 1,
      number: 5,
      title: 't',
      state: 'closed',
      merged_at: '2026-06-01T00:00:00Z',
      base: { ref: 'main', repo: { id: 77 } },
      head: { ref: 'f', sha: 's', repo: { id: 88 } },
    }
    expect(gp.pullRepoGithubId(base)).toBe(77)
    const pr = gp.toPullRequestProjection(base, gp.pullRepoGithubId(base)!, 0)
    expect(pr.merged).toBe(true)
    expect(pr.state).toBe('closed')
    expect(pr.repoGithubId).toBe(77)
  })

  it('flags PRs surfaced by the issues API and normalises labels', () => {
    const asPr = { id: 1, number: 2, title: 'x', state: 'open', pull_request: { url: '…' } }
    expect(gp.isPullRequest(asPr)).toBe(true)

    const issue = gp.toIssueProjection(
      { id: 1, number: 2, title: 'x', state: 'open', labels: [{ name: 'bug' }, 'chore', {}] },
      10,
      0,
    )
    expect(issue.labels).toEqual(['bug', 'chore'])
  })

  it('maps commits from both REST and push-webhook shapes', () => {
    const rest = gp.toCommitProjection(
      {
        sha: 'abc',
        commit: { message: 'm', author: { name: 'dev', date: '2026-06-01T00:00:00Z' } },
      },
      10,
      0,
    )
    expect(rest).toMatchObject({ sha: 'abc', message: 'm', author: 'dev' })

    const push = gp.toCommitProjection(
      { id: 'def', message: 'p', timestamp: '2026-06-02T00:00:00Z' },
      10,
      0,
    )
    expect(push.sha).toBe('def')
    expect(push.authoredAt).toBe(Date.parse('2026-06-02T00:00:00Z'))
  })
})
