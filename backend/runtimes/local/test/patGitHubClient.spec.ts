import type { GitHubClient, GitHubRepo, GroupCacheHandle } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalGitHubClient } from '../src/github.js'

// Focused unit coverage for the PAT-backed GitHub client's repo enumeration (no DB, no
// network): a multi-page `/user/repos` set must fan out concurrently off the
// `Link: rel="last"` header (not crawl `rel="next"` one blocking request at a time), and
// the picker's realtime search must serve repeat lookups from the injected cache instead
// of re-walking the whole set on every keystroke.

const API = 'https://gh.test'
const PER_PAGE = 100

/** A minimal in-memory GroupCacheHandle: hit returns, miss loads + stores, errors cache nothing. */
function makeCache<T>(): GroupCacheHandle<T> {
  const store = new Map<string, T>()
  const scope = (key: string, group: string) => `${group} ${key}`
  return {
    get: async (key, group, load) => {
      const k = scope(key, group)
      if (store.has(k)) return store.get(k) as T
      const value = await load()
      store.set(k, value)
      return value
    },
    invalidate: async (key, group) => void store.delete(scope(key, group)),
    invalidateGroup: async (group) => {
      for (const k of store.keys()) if (k.startsWith(`${group} `)) store.delete(k)
    },
    invalidateAll: async () => store.clear(),
  }
}

/**
 * Stub `fetch` to serve `/user/repos` from the given pages, advertising the page count via
 * `Link: rel="last"` (as GitHub does for offset pagination). Returns the enumeration calls
 * (`/user/repos` requests only), each recorded as its `page` query param.
 */
function stubUserRepos(pages: Array<Array<{ id: number; name: string }>>): string[] {
  const enumerationPages: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (!url.pathname.endsWith('/user/repos')) {
      throw new Error(`unexpected fetch in test: ${url.toString()}`)
    }
    const page = Number(url.searchParams.get('page') ?? '1')
    enumerationPages.push(String(page))
    const body = (pages[page - 1] ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      private: false,
      default_branch: 'main',
      owner: { login: 'octocat' },
    }))
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        link: `<${API}/user/repos?per_page=${PER_PAGE}&page=${pages.length}>; rel="last"`,
      },
    })
  })
  return enumerationPages
}

function makeClient(cache?: GroupCacheHandle<GitHubRepo[]>): GitHubClient {
  const client = createLocalGitHubClient({ GITHUB_PAT: 'pat-token', GITHUB_API_BASE: API }, cache)
  if (!client) throw new Error('expected a PAT client')
  return client
}

const namesOf = (repos: GitHubRepo[]) => repos.map((r) => r.name).sort()

describe('[local] PAT GitHub client repo enumeration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enumerates every page and stamps rows as workspace-wide (app) repos', async () => {
    const calls = stubUserRepos([
      [{ id: 1, name: 'alpha' }],
      [{ id: 2, name: 'beta' }],
      [{ id: 3, name: 'gamma' }],
    ])
    const client = makeClient()

    const { items } = await client.listInstallationRepos(7)

    expect(namesOf(items)).toEqual(['alpha', 'beta', 'gamma'])
    // Local mode's shared GITHUB_PAT is the workspace credential, so its repos are
    // App-reachable (visible to every member), attributed to the real installation.
    expect(items.every((r) => r.linkedVia === 'app')).toBe(true)
    expect(items.every((r) => r.installationId === 7)).toBe(true)
    // Page 1 revealed the page count via rel="last"; pages 2..3 were fetched off it
    // (one request per page — no serial re-walk from page 1).
    expect(calls).toEqual(['1', '2', '3'])
  })

  it('serves repeat picker searches from the cache — one walk, many keystrokes', async () => {
    const calls = stubUserRepos([
      [
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ],
    ])
    const client = makeClient(makeCache<GitHubRepo[]>())

    const first = await client.searchInstallationRepos(7, 'alp')
    const second = await client.searchInstallationRepos(7, 'bet')

    expect(namesOf(first)).toEqual(['alpha'])
    expect(namesOf(second)).toEqual(['beta'])
    // The second keystroke filtered the cached set in memory — no fresh enumeration.
    expect(calls).toEqual(['1'])
  })

  it('enumerates live per search when no cache is wired', async () => {
    const calls = stubUserRepos([[{ id: 1, name: 'alpha' }]])
    const client = makeClient()

    await client.searchInstallationRepos(7, 'alp')
    await client.searchInstallationRepos(7, 'alp')

    expect(calls).toEqual(['1', '1'])
  })
})
