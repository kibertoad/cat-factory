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

  it('reads the PR base ref (the branch protection should be read against)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ base: { ref: 'release/2026' }, head: { sha: 'h' } })),
    )
    await expect(makeClient().getPullRequestBaseRef(1, ref, 7)).resolves.toBe('release/2026')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'Not Found' }, 404)),
    )
    await expect(makeClient().getPullRequestBaseRef(1, ref, 7)).resolves.toBeNull()
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
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
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

describe('FetchGitHubClient.createReview (per-comment posting)', () => {
  const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase()

  it('posts each inline comment individually + the body, reporting every success', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (method(init) === 'GET' && url.endsWith('/pulls/7'))
        return json({ head: { sha: 'head-sha' } })
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json({}, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeClient().createReview(1, ref, 7, {
      event: 'COMMENT',
      body: 'Overall summary',
      comments: [
        { path: 'a.ts', line: 3, body: 'nit', side: 'RIGHT' },
        { path: 'b.ts', line: 9, body: 'bug' },
      ],
    })

    expect(result.comments).toEqual([{ posted: true }, { posted: true }])
    expect(result.bodyPosted).toBe(true)
    // Two inline review comments carry the resolved head sha as commit_id; the body is an issue comment.
    const inline = calls.filter((c) => c.url.includes('/pulls/7/comments'))
    expect(inline).toHaveLength(2)
    expect(inline[0]!.body).toMatchObject({
      commit_id: 'head-sha',
      path: 'a.ts',
      line: 3,
      side: 'RIGHT',
    })
    expect(calls.some((c) => c.url.includes('/issues/7/comments'))).toBe(true)
  })

  it('records a per-comment failure (line outside the diff) without rejecting the others', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (method(init) === 'GET' && url.endsWith('/pulls/7'))
        return json({ head: { sha: 'head-sha' } })
      if (url.includes('/pulls/7/comments')) {
        const body = JSON.parse(String(init?.body)) as { path: string }
        if (body.path === 'bad.ts')
          return json(
            { message: 'Unprocessable Entity', errors: ['Line could not be resolved'] },
            422,
          )
        return json({}, 201)
      }
      return json({}, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeClient().createReview(1, ref, 7, {
      event: 'COMMENT',
      comments: [
        { path: 'good.ts', line: 3, body: 'ok' },
        { path: 'bad.ts', line: 999, body: 'nope' },
      ],
    })

    expect(result.comments[0]).toEqual({ posted: true })
    expect(result.comments[1]!.posted).toBe(false)
    expect(result.comments[1]!.error).toMatch(/Line could not be resolved/)
    expect(result.bodyPosted).toBeNull()
  })

  it('reports every comment failed (no throw) when the PR head cannot be resolved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'Not Found' }, 404)),
    )
    const result = await makeClient().createReview(1, ref, 7, {
      event: 'COMMENT',
      body: 'summary',
      comments: [{ path: 'a.ts', line: 1, body: 'x' }],
    })
    expect(result.comments[0]!.posted).toBe(false)
    expect(result.bodyPosted).toBe(false)
    expect(result.bodyError).toBeTruthy()
  })
})
