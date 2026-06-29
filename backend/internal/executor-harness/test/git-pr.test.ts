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
      'GET https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests?source_branch=feature&state=opened':
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
})
