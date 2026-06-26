import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { ensureWorkBranchViaRest } from '../src/github/ensureWorkBranch.js'

// `ensureWorkBranchViaRest` is the one genuinely new piece of logic in the shared
// work-branch feature, and the integration/conformance suites run it ABSENT (no GitHub
// wired), so it is exercised here directly against the real `fetch`, intercepted by undici's
// MockAgent (instead of a hand-built fake Response). The behaviours that matter: probe-first
// (an existing branch is ready in one call), the writer-vs-read-only `create` intent,
// idempotency on a 422 race, slash-safe ref encoding, and the best-effort fallback to `false`
// on any failure. `disableNetConnect` makes any un-mocked request fail loudly — and because the
// interceptors match on the exact path, the slash-safe encoding is enforced by the match itself.
const GH = 'https://api.github.com'
const REPO = '/repos/acme/widgets'
const WORK = `${REPO}/git/ref/heads/cat-factory/blk_1`
const MAIN = `${REPO}/git/ref/heads/main`
const REFS = `${REPO}/git/refs`

const BASE_INPUT = {
  token: 'tok',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
  branch: 'cat-factory/blk_1',
}

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
})

afterEach(async () => {
  setGlobalDispatcher(previousDispatcher)
  await agent.close()
})

interface SeenRequest {
  method: string
  /** Request path (full, incl. any query) — host-relative. */
  path: string
  body: string
}

/** A recorder over `origin` exposing `route(method, path, status, json?)` + the captured calls. */
function gh(origin = GH) {
  const calls: SeenRequest[] = []
  const pool = agent.get(origin)
  function route(method: string, path: string, status: number, json?: unknown) {
    pool.intercept({ path, method }).reply(status, (opts) => {
      calls.push({
        method: String(opts.method),
        path: String(opts.path),
        body: opts.body ? String(opts.body) : '',
      })
      return json !== undefined ? JSON.stringify(json) : ''
    })
  }
  return { calls, route, pool }
}

describe('ensureWorkBranchViaRest', () => {
  it('reports ready in a single call when the work branch already exists', async () => {
    const { calls, route } = gh()
    route('GET', WORK, 200, { object: { sha: 'abc' } })

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(true)
    // Probe only — no base resolve, no create POST (an un-mocked call would have thrown).
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe(WORK)
  })

  it('creates the branch from the base tip when absent and create is requested', async () => {
    const { calls, route } = gh()
    route('GET', WORK, 404)
    route('GET', MAIN, 200, { object: { sha: 'basesha' } })
    route('POST', REFS, 201)

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(true)
    const post = calls.find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    expect(JSON.parse(post!.body)).toEqual({ ref: 'refs/heads/cat-factory/blk_1', sha: 'basesha' })
  })

  it('treats a 422 "already exists" on create as success (race)', async () => {
    const { route } = gh()
    route('GET', WORK, 404)
    route('GET', MAIN, 200, { object: { sha: 'basesha' } })
    route('POST', REFS, 422)

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(true)
  })

  it('does NOT create the branch for a read-only (probe-only) caller', async () => {
    const { calls, route } = gh()
    route('GET', WORK, 404)

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: false })).resolves.toBe(false)
    // Probe missed (404) and create is off ⇒ stops; no base resolve, no POST.
    expect(calls).toHaveLength(1)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('returns false when the base branch tip cannot be resolved', async () => {
    const { calls, route } = gh()
    route('GET', WORK, 404)
    route('GET', MAIN, 404)

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(false)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('encodes a slashed base branch as path segments, not %2F', async () => {
    const RELEASE = `${REPO}/git/ref/heads/release/2026`
    const { calls, route } = gh()
    route('GET', WORK, 404)
    route('GET', RELEASE, 200, { object: { sha: 'basesha' } })
    route('POST', REFS, 201)

    await expect(
      ensureWorkBranchViaRest({ ...BASE_INPUT, baseBranch: 'release/2026', create: true }),
    ).resolves.toBe(true)
    // The base ref was resolved at the slash-segmented path (the %2F-encoded form would not
    // have matched the interceptor and the disabled net connection would have thrown).
    expect(calls.some((c) => c.path === RELEASE)).toBe(true)
    expect(calls.some((c) => c.path.includes('release%2F2026'))).toBe(false)
  })

  it('swallows a thrown fetch and falls back to false', async () => {
    agent.get(GH).intercept({ path: WORK, method: 'GET' }).replyWithError(new Error('network down'))

    await expect(ensureWorkBranchViaRest({ ...BASE_INPUT, create: true })).resolves.toBe(false)
  })

  it('honours a custom apiBase (GitHub Enterprise) and trims trailing slashes', async () => {
    const GHE = 'https://ghe.acme.com'
    const { calls, route } = gh(GHE)
    route('GET', '/api/v3/repos/acme/widgets/git/ref/heads/cat-factory/blk_1', 200, {
      object: { sha: 'abc' },
    })

    await ensureWorkBranchViaRest({
      ...BASE_INPUT,
      apiBase: 'https://ghe.acme.com/api/v3/',
      create: false,
    })
    expect(`${GHE}${calls[0]!.path}`).toBe(
      'https://ghe.acme.com/api/v3/repos/acme/widgets/git/ref/heads/cat-factory/blk_1',
    )
  })
})
