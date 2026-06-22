import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureWorkBranchViaRest } from '../src/github/ensureWorkBranch.js'

// `ensureWorkBranchViaRest` is the one genuinely new piece of logic in the shared
// work-branch feature, and the integration/conformance suites run it ABSENT (no GitHub
// wired), so it is exercised here directly against a mocked `fetch`. The behaviours that
// matter: probe-first (an existing branch is ready in one call), the writer-vs-read-only
// `create` intent, idempotency on a 422 race, slash-safe ref encoding, and the
// best-effort fallback to `false` on any failure.

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function resp(status: number, body?: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? null,
  }
}

const BASE_INPUT = {
  token: 'tok',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
  branch: 'cat-factory/blk_1',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Install a fake `fetch` that routes by `${method} ${url}`, recording the calls. */
function stubFetch(handler: (url: string, method: string) => FakeResponse | Promise<FakeResponse>) {
  const calls: { url: string; method: string; body?: string }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method, body: init?.body as string | undefined })
    return handler(url, method) as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

describe('ensureWorkBranchViaRest', () => {
  it('reports ready in a single call when the work branch already exists', async () => {
    const calls = stubFetch((url) => {
      expect(url).toContain('/git/ref/heads/cat-factory/blk_1')
      return resp(200, { object: { sha: 'abc' } })
    })

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(true)
    // Probe only — no base resolve, no create POST.
    expect(calls).toHaveLength(1)
  })

  it('creates the branch from the base tip when absent and create is requested', async () => {
    const calls = stubFetch((url, method) => {
      if (url.endsWith('/git/ref/heads/cat-factory/blk_1') && method === 'GET') return resp(404)
      if (url.endsWith('/git/ref/heads/main') && method === 'GET')
        return resp(200, { object: { sha: 'basesha' } })
      if (url.endsWith('/git/refs') && method === 'POST') return resp(201)
      throw new Error(`unexpected ${method} ${url}`)
    })

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(true)
    const post = calls.find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    expect(JSON.parse(post!.body!)).toEqual({ ref: 'refs/heads/cat-factory/blk_1', sha: 'basesha' })
  })

  it('treats a 422 "already exists" on create as success (race)', async () => {
    stubFetch((url, method) => {
      if (url.endsWith('/git/ref/heads/cat-factory/blk_1') && method === 'GET') return resp(404)
      if (url.endsWith('/git/ref/heads/main') && method === 'GET')
        return resp(200, { object: { sha: 'basesha' } })
      if (url.endsWith('/git/refs') && method === 'POST') return resp(422)
      throw new Error(`unexpected ${method} ${url}`)
    })

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(true)
  })

  it('does NOT create the branch for a read-only (probe-only) caller', async () => {
    const calls = stubFetch(() => resp(404))

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: false })).resolves.toBe(false)
    // Probe missed (404) and create is off ⇒ stops; no base resolve, no POST.
    expect(calls).toHaveLength(1)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('returns false when the base branch tip cannot be resolved', async () => {
    const calls = stubFetch((url, method) => {
      if (url.endsWith('/git/ref/heads/cat-factory/blk_1') && method === 'GET') return resp(404)
      if (url.endsWith('/git/ref/heads/main') && method === 'GET') return resp(404)
      throw new Error(`unexpected ${method} ${url}`)
    })

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(false)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('encodes a slashed base branch as path segments, not %2F', async () => {
    const seen: string[] = []
    stubFetch((url, method) => {
      seen.push(url)
      if (url.endsWith('/git/ref/heads/cat-factory/blk_1') && method === 'GET') return resp(404)
      if (method === 'GET') return resp(200, { object: { sha: 'basesha' } })
      return resp(201)
    })

    await expect(
      ensureWorkBranchViaRest({ ...BASE_INPUT, baseBranch: 'release/2026', create: true }),
    ).resolves.toBe(true)
    expect(seen.some((u) => u.endsWith('/git/ref/heads/release/2026'))).toBe(true)
    expect(seen.some((u) => u.includes('release%2F2026'))).toBe(false)
  })

  it('swallows a thrown fetch and falls back to false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(false)
  })

  it('honours a custom apiBase (GitHub Enterprise) and trims trailing slashes', async () => {
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      return resp(200, { object: { sha: 'abc' } })
    })

    await ensureWorkBranchViaRest({
      ...BASE_INPUT,
      apiBase: 'https://ghe.acme.com/api/v3/',
      create: false,
    })
    expect(seen[0]).toBe(
      'https://ghe.acme.com/api/v3/repos/acme/widgets/git/ref/heads/cat-factory/blk_1',
    )
  })
})
