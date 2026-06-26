import type {
  GitHubRepoRef,
  IdGenerator,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// The human-review gate's GitHub reads/mutations: the REST review/comment/requested-reviewer +
// branch-protection reads and the GraphQL review-thread reads/mutations. This single suite guards
// the request shape + response mapping for every facade (they all share FetchGitHubClient).

const noopRateLimit: RateLimitRepository = {
  record: async (_s: RateLimitSnapshot) => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'o', repo: 'r' }

const registry: AppTokenSource = {
  defaultAppId: 'app',
  apps: () => [{ appId: 'app' }],
  authForApp: () => ({ appJwt: async () => 'jwt' }),
  installationToken: async () => 'tok',
  installationPermissions: async () => ({}),
}

function makeClient(): FetchGitHubClient {
  return new FetchGitHubClient({
    registry,
    rateLimitRepository: noopRateLimit,
    idGenerator,
    clock,
    apiBase: 'https://api.github.com',
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient PR-review reads', () => {
  it('lists requested reviewer logins', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ users: [{ login: 'alice' }, { login: 'bob' }], teams: [] })),
    )
    await expect(makeClient().listRequestedReviewers(1, ref, 7)).resolves.toEqual(['alice', 'bob'])
  })

  it('maps reviews to {author,state,submittedAt(ms),commitId}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          {
            user: { login: 'alice' },
            state: 'APPROVED',
            submitted_at: '2026-01-02T03:04:05Z',
            commit_id: 'abc',
          },
        ]),
      ),
    )
    const reviews = await makeClient().listPullRequestReviews(1, ref, 7)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ author: 'alice', state: 'APPROVED', commitId: 'abc' })
    expect(reviews[0]!.submittedAt).toBe(Date.parse('2026-01-02T03:04:05Z'))
  })

  it('reads required_approving_review_count, defaulting to 1 on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ required_approving_review_count: 2 })),
    )
    await expect(makeClient().getRequiredApprovingReviewCount(1, ref, 'main')).resolves.toBe(2)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'Not Found' }, 404)),
    )
    await expect(makeClient().getRequiredApprovingReviewCount(1, ref, 'main')).resolves.toBe(1)
  })

  it('reads GraphQL review threads (resolved state + anchor + comments)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'T1',
                      isResolved: false,
                      path: 'src/a.ts',
                      line: 12,
                      comments: {
                        nodes: [
                          {
                            author: { login: 'alice' },
                            body: 'rename',
                            createdAt: '2026-01-02T00:00:00Z',
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      ),
    )
    const threads = await makeClient().listReviewThreads(1, ref, 7)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ id: 'T1', isResolved: false, path: 'src/a.ts', line: 12 })
    expect(threads[0]!.comments[0]).toMatchObject({ author: 'alice', body: 'rename' })
  })

  it('resolveReviewThread posts the GraphQL mutation (no throw on success)', async () => {
    const fetchMock = vi.fn(async () =>
      json({ data: { resolveReviewThread: { thread: { id: 'T1' } } } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(makeClient().resolveReviewThread(1, ref, 'T1')).resolves.toBeUndefined()
    const [, init] = fetchMock.mock.calls[0]!
    expect(String(init?.body)).toContain('resolveReviewThread')
  })

  it('throws on a GraphQL errors payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ errors: [{ message: 'boom' }] })),
    )
    await expect(makeClient().listReviewThreads(1, ref, 7)).rejects.toThrow(/boom/)
  })
})
