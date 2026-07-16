import type {
  GitHubRepoRef,
  IdGenerator,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// openPullRequest is documented (RepoFiles / GitHubClient ports) as IDEMPOTENT: re-opening a PR
// for a head/base that already has an open one returns that existing PR rather than failing.
// GitHub rejects the duplicate create with a 422, so the client must fall back to a lookup —
// this is what makes a durable-driver replay of a committing post-op (e.g. the `spike` findings
// PR) safe. This client is shared by every facade, so this single suite guards it for all.

const noopRateLimit: RateLimitRepository = {
  record: async (_snapshot: RateLimitSnapshot) => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'acme', repo: 'repo' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const registry: AppTokenSource = {
  defaultAppId: 'app',
  apps: () => [{ appId: 'app' }],
  authForApp: () => ({ appJwt: async () => 'jwt' }),
  installationToken: async () => 'token',
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

const PR_PAYLOAD = {
  id: 700,
  number: 7,
  title: 'Spike findings',
  state: 'open',
  head: { ref: 'cat-factory/task_login', sha: 'headsha' },
  base: { ref: 'main', repo: { id: 1 } },
  merged: false,
  user: { login: 'bot' },
  html_url: 'https://github.com/acme/repo/pull/7',
  updated_at: '1970-01-01T00:00:00Z',
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.openPullRequest', () => {
  it('returns the created PR with its web url', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(PR_PAYLOAD)),
    )
    const pr = await makeClient().openPullRequest(1, ref, {
      title: 'Spike findings',
      head: 'cat-factory/task_login',
      base: 'main',
    })
    expect(pr.number).toBe(7)
    expect(pr.url).toBe('https://github.com/acme/repo/pull/7')
  })

  it('is idempotent: a 422 (PR already exists) resolves to the existing open PR', async () => {
    const calls: { url: string; method: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        calls.push({ url, method })
        // The create POST is rejected because a matching open PR already exists.
        if (method === 'POST') {
          return jsonResponse({ message: 'A pull request already exists for acme:branch.' }, 422)
        }
        // The idempotent lookup returns that existing open PR.
        return jsonResponse([PR_PAYLOAD])
      }),
    )
    const pr = await makeClient().openPullRequest(1, ref, {
      title: 'Spike findings',
      head: 'cat-factory/task_login',
      base: 'main',
    })
    expect(pr.number).toBe(7)
    expect(pr.url).toBe('https://github.com/acme/repo/pull/7')
    // Fell back from the POST to a filtered `state=open` list keyed on head/base.
    expect(calls[0]?.method).toBe('POST')
    const lookup = calls[1]?.url ?? ''
    expect(lookup).toContain('state=open')
    expect(lookup).toContain('head=acme%3Acat-factory%2Ftask_login')
    expect(lookup).toContain('base=main')
  })

  it('rethrows the 422 when no matching open PR can be found (a genuine failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'POST') {
          return jsonResponse({ message: 'Validation failed' }, 422)
        }
        return jsonResponse([])
      }),
    )
    await expect(
      makeClient().openPullRequest(1, ref, {
        title: 'Spike findings',
        head: 'cat-factory/task_login',
        base: 'main',
      }),
    ).rejects.toThrow()
  })
})
