import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitlabApiBaseFromCloneUrl,
  gitlabProjectPath,
  inferVcsProvider,
  openPullRequest,
} from '../src/git.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inferVcsProvider', () => {
  it('detects GitLab from the clone URL host (gitlab.com + self-managed)', () => {
    expect(inferVcsProvider('https://gitlab.com/group/proj.git')).toBe('gitlab')
    expect(inferVcsProvider('https://gitlab.example.com/group/proj.git')).toBe('gitlab')
  })

  it('defaults to GitHub (incl. enterprise hosts and unparseable input)', () => {
    expect(inferVcsProvider('https://github.com/o/r.git')).toBe('github')
    expect(inferVcsProvider('https://github.acme.com/o/r.git')).toBe('github')
    expect(inferVcsProvider('not a url')).toBe('github')
  })
})

describe('gitlab url helpers', () => {
  it('derives the REST base from the host', () => {
    expect(gitlabApiBaseFromCloneUrl('https://gitlab.com/group/proj.git')).toBe(
      'https://gitlab.com/api/v4',
    )
    expect(gitlabApiBaseFromCloneUrl('https://gitlab.example.com/g/p.git')).toBe(
      'https://gitlab.example.com/api/v4',
    )
  })

  it('URL-encodes the full namespace path (subgroups survive)', () => {
    expect(gitlabProjectPath('https://gitlab.com/group/sub/proj.git')).toBe('group%2Fsub%2Fproj')
  })
})

/** Scripted global fetch recording requests, returning the queued response per route. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] =
    []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      )
      calls.push({
        method,
        url: u,
        headers,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      const route = routes[`${method} ${u}`] ?? routes[u]
      if (!route) throw new Error(`Unexpected request: ${method} ${u}`)
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

describe('openPullRequest (provider dispatch)', () => {
  it('opens a GitLab merge request for a gitlab clone URL', async () => {
    const calls = stubFetch({
      'POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests': {
        body: { web_url: 'https://gitlab.com/group/proj/-/merge_requests/3' },
      },
    })
    const url = await openPullRequest({
      owner: 'group',
      name: 'proj',
      ghToken: 'glpat-x',
      head: 'feature',
      base: 'main',
      pr: { title: 'T', body: 'B' },
      cloneUrl: 'https://gitlab.com/group/proj.git',
    })
    expect(url).toBe('https://gitlab.com/group/proj/-/merge_requests/3')
    const post = calls.at(-1)!
    expect(post.headers['private-token']).toBe('glpat-x')
    expect(post.body).toEqual({
      source_branch: 'feature',
      target_branch: 'main',
      title: 'T',
      description: 'B',
    })
  })

  it('returns the existing MR url when one already exists (resumed run)', async () => {
    const calls = stubFetch({
      'POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests': {
        status: 409,
        body: { message: ['another open merge request already exists'] },
      },
      'GET https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests?source_branch=feature&target_branch=main&state=opened':
        { body: [{ web_url: 'https://gitlab.com/group/proj/-/merge_requests/9' }] },
    })
    const url = await openPullRequest({
      owner: 'group',
      name: 'proj',
      ghToken: 'glpat-x',
      head: 'feature',
      base: 'main',
      pr: { title: 'T', body: 'B' },
      cloneUrl: 'https://gitlab.com/group/proj.git',
    })
    expect(url).toBe('https://gitlab.com/group/proj/-/merge_requests/9')
    expect(calls).toHaveLength(2)
  })

  it('still opens a GitHub PR for a github clone URL (unchanged path)', async () => {
    const calls = stubFetch({
      'POST https://api.github.com/repos/o/r/pulls': {
        body: { html_url: 'https://github.com/o/r/pull/5' },
      },
    })
    const url = await openPullRequest({
      owner: 'o',
      name: 'r',
      ghToken: 'ghp_x',
      head: 'feature',
      base: 'main',
      pr: { title: 'T', body: 'B' },
      cloneUrl: 'https://github.com/o/r.git',
    })
    expect(url).toBe('https://github.com/o/r/pull/5')
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer ghp_x')
  })

  it('opens an MR when provider is set explicitly, even for a self-managed host inference misses', async () => {
    // `git.acme.com` is NOT recognised by inferVcsProvider (it would default to GitHub), so the
    // explicit provider is the only thing that routes this to GitLab — the self-managed case.
    const calls = stubFetch({
      'POST https://git.acme.com/api/v4/projects/team%2Fproj/merge_requests': {
        body: { web_url: 'https://git.acme.com/team/proj/-/merge_requests/7' },
      },
    })
    const url = await openPullRequest({
      owner: 'team',
      name: 'proj',
      ghToken: 'glpat-x',
      head: 'feature',
      base: 'main',
      pr: { title: 'T', body: 'B' },
      cloneUrl: 'https://git.acme.com/team/proj.git',
      provider: 'gitlab',
    })
    expect(url).toBe('https://git.acme.com/team/proj/-/merge_requests/7')
    expect(calls.at(-1)!.headers['private-token']).toBe('glpat-x')
  })

  it('opens a GitHub PR when provider is set to github even for a gitlab-named host', async () => {
    // The explicit provider overrides host inference in BOTH directions.
    const calls = stubFetch({
      'POST https://api.github.com/repos/o/r/pulls': {
        body: { html_url: 'https://github.com/o/r/pull/8' },
      },
    })
    const url = await openPullRequest({
      owner: 'o',
      name: 'r',
      ghToken: 'ghp_x',
      head: 'feature',
      base: 'main',
      pr: { title: 'T', body: 'B' },
      cloneUrl: 'https://gitlab.com/o/r.git',
      provider: 'github',
    })
    expect(url).toBe('https://github.com/o/r/pull/8')
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer ghp_x')
  })
})

/** Stub global fetch to return a SEQUENCE of responses (one per successive call). */
function stubFetchSequence(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { count: () => number } {
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]!
      i++
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json', ...r.headers },
      })
    }),
  )
  return { count: () => i }
}

const githubPr = {
  owner: 'o',
  name: 'r',
  ghToken: 'ghp_x',
  head: 'feature',
  base: 'main',
  pr: { title: 'T', body: 'B' },
  cloneUrl: 'https://github.com/o/r.git',
} as const

describe('openPullRequest (transient retry)', () => {
  afterEach(() => vi.useRealTimers())

  it('retries a 503 and then succeeds', async () => {
    vi.useFakeTimers()
    const seq = stubFetchSequence([
      { status: 503, body: { message: 'upstream blip' } },
      { status: 201, body: { html_url: 'https://github.com/o/r/pull/11' } },
    ])
    const p = openPullRequest({ ...githubPr })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBe('https://github.com/o/r/pull/11')
    expect(seq.count()).toBe(2)
  })

  it('honors a 429 Retry-After then succeeds', async () => {
    vi.useFakeTimers()
    const seq = stubFetchSequence([
      { status: 429, body: { message: 'rate limited' }, headers: { 'retry-after': '1' } },
      { status: 201, body: { html_url: 'https://github.com/o/r/pull/12' } },
    ])
    const p = openPullRequest({ ...githubPr })
    // Less than the 1s Retry-After: still pending.
    await vi.advanceTimersByTimeAsync(500)
    // Past it: the retry fires and resolves.
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(p).resolves.toBe('https://github.com/o/r/pull/12')
    expect(seq.count()).toBe(2)
  })

  it('throws (redacted) after exhausting retries on a persistent 5xx, tagged cause `api`', async () => {
    vi.useFakeTimers()
    const seq = stubFetchSequence([{ status: 500, body: { message: 'still down' } }])
    const p = openPullRequest({ ...githubPr })
    // Capture the rejection so we can assert BOTH the message and the structured cause.
    const caught = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Failed to open PR \(HTTP 500\)/)
    // The PR-open failure carries the structured `api` cause for the backend to classify on.
    expect((err as { failureCause?: string }).failureCause).toBe('api')
    // 3 attempts total (initial + 2 retries), no more.
    expect(seq.count()).toBe(3)
  })

  it('honors an HTTP-date Retry-After then succeeds', async () => {
    vi.useFakeTimers()
    // 2s in the future as an HTTP-date — must wait it out, not fall back to the 0.5s backoff.
    const future = new Date(Date.now() + 2_000).toUTCString()
    const seq = stubFetchSequence([
      { status: 503, body: { message: 'slow down' }, headers: { 'retry-after': future } },
      { status: 201, body: { html_url: 'https://github.com/o/r/pull/14' } },
    ])
    const p = openPullRequest({ ...githubPr })
    // Before the date: the retry has not fired yet.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seq.count()).toBe(1)
    // Past it: the retry fires and resolves.
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(p).resolves.toBe('https://github.com/o/r/pull/14')
    expect(seq.count()).toBe(2)
  })

  it('returns null on a 422 "No commits between" (nothing to PR — a clean no-op)', async () => {
    // A resumed branch reachable from base has nothing ahead: GitHub answers 422 "No commits
    // between main and <branch>". That is not an API failure — it must surface as a no-op
    // (null), not the opaque `Failed to open PR` HarnessFailure, and it must not be retried.
    const seq = stubFetchSequence([
      {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'No commits between main and feature' }],
        },
      },
    ])
    await expect(openPullRequest({ ...githubPr })).resolves.toBeNull()
    // Exactly one call: the POST is not retried and there is no existing-PR lookup.
    expect(seq.count()).toBe(1)
  })

  it('does NOT retry a 422 "already exists" — returns the existing PR', async () => {
    // 422 is not transient: it must fall straight through to the existing-PR lookup, not retry.
    const seq = stubFetchSequence([
      { status: 422, body: { message: 'A pull request already exists for o:feature.' } },
      { status: 200, body: [{ html_url: 'https://github.com/o/r/pull/13' }] },
    ])
    const url = await openPullRequest({ ...githubPr })
    expect(url).toBe('https://github.com/o/r/pull/13')
    // Exactly two calls: the POST (not retried) + the lookup GET.
    expect(seq.count()).toBe(2)
  })

  it('rejects immediately when the watchdog aborts mid-backoff (no further attempts)', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const seq = stubFetchSequence([{ status: 503, body: { message: 'blip' } }])
    const p = openPullRequest({ ...githubPr, signal: controller.signal })
    const assertion = expect(p).rejects.toThrow(/aborted by watchdog/)
    // First attempt (503) has resolved and we're now in the backoff wait; abort it.
    await vi.advanceTimersByTimeAsync(10)
    controller.abort(new Error('aborted by watchdog'))
    await assertion
    // Only the first attempt ran; the retry never fired.
    expect(seq.count()).toBe(1)
  })
})
