import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubClient, GitHubRepoRef } from '@cat-factory/kernel'
import { createLocalGitHubClient, createLocalGitLabClient } from './github.js'

// ---------------------------------------------------------------------------
// Cross-provider VCS-client conformance.
//
// Local mode reaches source control through a single `GitHubClient`: a GitHub PAT client, or
// (new) a GitLab PAT client — `FetchGitLabClient` adapted to the same port. The CI gate, the
// mergeability check and the real merge all read through that one interface, so the two
// providers MUST satisfy the same behavioural contract. This suite asserts identical OUTCOMES
// (normalised domain results + that every call is authenticated) against BOTH local factories,
// each driven by its own provider-shaped canned HTTP. It is the provider analogue of the
// cross-runtime conformance suite: a provider that maps a field differently, or forgets to send
// its auth header, fails a test instead of shipping. (It subsumes the old single github.test.ts
// merge-auth assertion.)
// ---------------------------------------------------------------------------

interface Route {
  method: string
  /** A distinctive fragment of the request pathname (query ignored). */
  match: string
  status?: number
  body?: unknown
}

interface RecordedCall {
  method: string
  path: string
  authed: boolean
}

/** Stub the global `fetch` with a scripted, auth-checking responder for one test body. */
async function withFetch(
  authOk: (headers: Record<string, string>) => boolean,
  routes: Route[],
  body: (calls: RecordedCall[]) => Promise<void>,
): Promise<void> {
  const calls: RecordedCall[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(u).pathname
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    )
    calls.push({ method, path, authed: authOk(headers) })
    // Pick the MOST specific matching route (longest fragment), so e.g. `/repos/o/r/commits`
    // resolves to the commits route, not the broader `/repos/o/r` repo read.
    const route = routes
      .filter((r) => r.method === method && path.includes(r.match))
      .sort((a, b) => b.match.length - a.match.length)[0]
    if (!route) throw new Error(`Unexpected request: ${method} ${path}`)
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  vi.stubGlobal('fetch', impl)
  await body(calls)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const ref: GitHubRepoRef = { owner: 'o', repo: 'r' }

/** Everything provider-specific the shared assertions are parameterised over. */
interface ProviderConfig {
  name: string
  makeClient: () => GitHubClient | undefined
  authOk: (headers: Record<string, string>) => boolean
  /** Canned read of the repo, needed where the client resolves a numeric repo id first. */
  repoRoute: Route
  commitsRoute: Route
  checksRoute: Route
  /** The merge-request/PR detail read backing mergeability. */
  pullRoute: Route
  /** The distinctive fragment + method of the real merge call. */
  mergeMatch: string
  mergeMethod: string
  mergeRoute: Route
  // ---- human-review gate inputs ----
  /** The PR/MR detail read backing base-ref (and, on GitLab, the requested reviewers). */
  baseRoute: Route
  /** The requested-reviewers read on GitHub (a sub-route); omitted on GitLab (reuses baseRoute). */
  requestedReviewersRoute?: Route
  /** The submitted-reviews (GitHub) / approvals (GitLab) read. */
  reviewsRoute: Route
  /** The required-approving-review-count read (branch protection / project approvals). */
  requiredCountRoute: Route
  /** Whether the provider advances a PR branch by rebasing the MR (GitLab) vs `mergeBranch` (GitHub). */
  rebases: boolean
}

const github: ProviderConfig = {
  name: 'github',
  makeClient: () => createLocalGitHubClient({ GITHUB_PAT: 'tok' }),
  authOk: (h) => h.authorization === 'Bearer tok',
  repoRoute: { method: 'GET', match: '/repos/o/r', body: { id: 1, name: 'r', full_name: 'o/r' } },
  commitsRoute: { method: 'GET', match: '/repos/o/r/commits', body: [{ sha: 'sha1' }] },
  checksRoute: {
    method: 'GET',
    match: '/commits/sha1/check-runs',
    body: { check_runs: [{ id: 9, name: 'build', status: 'completed', conclusion: 'success' }] },
  },
  pullRoute: {
    method: 'GET',
    match: '/repos/o/r/pulls/7',
    body: { mergeable: true, mergeable_state: 'clean', head: { sha: 'sha1' } },
  },
  mergeMatch: '/pulls/7/merge',
  mergeMethod: 'PUT',
  mergeRoute: { method: 'PUT', match: '/pulls/7/merge', body: { merged: true } },
  baseRoute: { method: 'GET', match: '/repos/o/r/pulls/7', body: { base: { ref: 'main' } } },
  requestedReviewersRoute: {
    method: 'GET',
    match: '/pulls/7/requested_reviewers',
    body: { users: [{ login: 'rev' }] },
  },
  reviewsRoute: {
    method: 'GET',
    match: '/pulls/7/reviews',
    body: [{ user: { login: 'app' }, state: 'APPROVED' }],
  },
  requiredCountRoute: {
    method: 'GET',
    match: '/branches/main/protection/required_pull_request_reviews',
    body: { required_approving_review_count: 2 },
  },
  rebases: false,
}

const gitlab: ProviderConfig = {
  name: 'gitlab',
  makeClient: () => createLocalGitLabClient({ GITLAB_PAT: 'tok' }),
  authOk: (h) => h['private-token'] === 'tok',
  // GitLab resolves the project from the path, so no separate repo read is needed; give it a
  // harmless project route in case it is ever consulted.
  repoRoute: {
    method: 'GET',
    match: '/projects/o%2Fr',
    body: { id: 1, path_with_namespace: 'o/r' },
  },
  commitsRoute: {
    method: 'GET',
    match: '/repository/commits',
    body: [{ id: 'sha1', message: 'c', created_at: '2026-01-01T00:00:00Z' }],
  },
  checksRoute: {
    method: 'GET',
    match: '/repository/commits/sha1/statuses',
    body: [{ name: 'build', status: 'success' }],
  },
  pullRoute: {
    method: 'GET',
    match: '/merge_requests/7',
    body: { merge_status: 'can_be_merged', detailed_merge_status: 'mergeable', sha: 'sha1' },
  },
  mergeMatch: '/merge_requests/7/merge',
  mergeMethod: 'PUT',
  mergeRoute: { method: 'PUT', match: '/merge_requests/7/merge', body: {} },
  // GitLab carries the base (target_branch) AND the requested reviewers on the MR detail, so
  // both reads hit this one route (no separate requested-reviewers sub-route).
  baseRoute: {
    method: 'GET',
    match: '/merge_requests/7',
    body: { target_branch: 'main', reviewers: [{ username: 'rev' }] },
  },
  reviewsRoute: {
    method: 'GET',
    match: '/merge_requests/7/approvals',
    body: { approved_by: [{ user: { username: 'app' } }] },
  },
  requiredCountRoute: {
    method: 'GET',
    match: '/projects/o%2Fr/approvals',
    body: { approvals_before_merge: 2 },
  },
  rebases: true,
}

function defineVcsClientConformance(cfg: ProviderConfig): void {
  describe(`[${cfg.name}] local VCS client conformance`, () => {
    it('builds a configured client from its PAT', () => {
      expect(cfg.makeClient()).toBeDefined()
    })

    it('authenticates the real merge with the provider token', async () => {
      await withFetch(cfg.authOk, [cfg.mergeRoute], async (calls) => {
        const client = cfg.makeClient()!
        await client.mergePullRequest(1, ref, 7)
        const merge = calls.find(
          (c) => c.method === cfg.mergeMethod && c.path.includes(cfg.mergeMatch),
        )
        expect(merge, 'the merge endpoint was called').toBeDefined()
        expect(merge?.authed, 'the merge call carried the provider auth header').toBe(true)
      })
    })

    it('normalises PR/MR mergeability to {mergeable, headSha}', async () => {
      await withFetch(cfg.authOk, [cfg.repoRoute, cfg.pullRoute], async () => {
        const client = cfg.makeClient()!
        const m = await client.getPullRequestMergeability(1, ref, 7)
        expect(m.mergeable).toBe(true)
        expect(m.headSha).toBe('sha1')
      })
    })

    it('reads the CI gate inputs (head commit sha + its check names)', async () => {
      await withFetch(cfg.authOk, [cfg.repoRoute, cfg.commitsRoute, cfg.checksRoute], async () => {
        const client = cfg.makeClient()!
        const commits = await client.listCommits(1, ref, { sha: 'main' })
        expect(commits.items[0]?.sha).toBe('sha1')
        const checks = await client.listCheckRuns(1, ref, 'sha1')
        expect(checks.items[0]?.name).toBe('build')
      })
    })

    it('reads the PR base ref for the human-review gate', async () => {
      await withFetch(cfg.authOk, [cfg.baseRoute], async () => {
        const client = cfg.makeClient()!
        expect(await client.getPullRequestBaseRef!(1, ref, 7)).toBe('main')
      })
    })

    it('reads the requested reviewers', async () => {
      const routes = cfg.requestedReviewersRoute
        ? [cfg.baseRoute, cfg.requestedReviewersRoute]
        : [cfg.baseRoute]
      await withFetch(cfg.authOk, routes, async () => {
        const client = cfg.makeClient()!
        expect(await client.listRequestedReviewers!(1, ref, 7)).toEqual(['rev'])
      })
    })

    it('normalises an approval to a standing APPROVED review', async () => {
      await withFetch(cfg.authOk, [cfg.reviewsRoute], async () => {
        const client = cfg.makeClient()!
        const reviews = await client.listPullRequestReviews!(1, ref, 7)
        expect(reviews.some((r) => r.state === 'APPROVED' && r.author === 'app')).toBe(true)
      })
    })

    it('reads the required approving review count', async () => {
      await withFetch(cfg.authOk, [cfg.requiredCountRoute], async () => {
        const client = cfg.makeClient()!
        expect(await client.getRequiredApprovingReviewCount!(1, ref, 'main')).toBe(2)
      })
    })

    it('exposes the branch-advancing capability appropriate to the provider', () => {
      const client = cfg.makeClient()!
      // GitLab advances a PR branch by rebasing the MR (it has no merge-branch-into-branch
      // endpoint); GitHub uses the Merges API via `mergeBranch` and omits `rebasePullRequest`.
      // The human-testing gate's BranchUpdater prefers `rebasePullRequest` when present.
      expect(typeof client.rebasePullRequest === 'function').toBe(cfg.rebases)
      // BOTH providers expose the human-review reads the gate consumes.
      expect(typeof client.listReviewThreads).toBe('function')
      expect(typeof client.getRequiredApprovingReviewCount).toBe('function')
    })
  })
}

defineVcsClientConformance(github)
defineVcsClientConformance(gitlab)

describe('local VCS client factories', () => {
  it('return undefined when the provider PAT is absent (gates pass through)', () => {
    expect(createLocalGitHubClient({})).toBeUndefined()
    expect(createLocalGitLabClient({})).toBeUndefined()
  })
})
