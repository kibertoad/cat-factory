import { describe, expect, it } from 'vitest'
import { REPO_CONTENT_APIS } from '../src/repoContentApi.ts'

// The plumbing under `repoPurge.ts`, over a fake transport. Three things in it are decisions rather
// than calls, and all three fail SILENTLY when they are wrong, which is why they are pinned here
// rather than left to an integration run:
//
//   - a ref path is encoded SEGMENT BY SEGMENT. Every branch this purge deletes is a
//     `cat-factory/<blockId>`, and a whole-string encode turns the separator into `%2F`, which the
//     provider does not match: the 404 that comes back is the answer this client reads as "already
//     gone". The purge would report every branch deleted and touch none of them.
//   - a 422 on a tag create is VERIFIED. GitHub answers it for "already exists" and for every way a
//     ref cannot be created at all, and believing the first records a backup that was never written,
//     which is what makes the following delete unrecoverable.
//   - a list is read to its LAST page. A fixture repository accumulates one branch per block per
//     run, so page one goes quietly short exactly where this command is used.

const TARGET = { owner: 'acme', repo: 'catalog-api' }

type Route = { status: number; body?: unknown }
type Call = { method: string; path: string; body?: string }

function github(routes: Record<string, Route>, calls: Call[] = []) {
  const build = REPO_CONTENT_APIS.github
  if (!build) throw new Error('the GitHub client is the one this suite must always have')
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace('https://api.test', '')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    const route = routes[`${method} ${path}`]
    const status = route?.status ?? 599
    // A 204 carries no body at all, which is what a real ref delete answers.
    return new Response(status === 204 ? null : JSON.stringify(route?.body ?? {}), { status })
  }) as unknown as typeof fetch
  return build({ token: 'reporter-secret', apiBaseUrl: 'https://api.test', fetchImpl })
}

/** `count` rows shaped like a branch listing, for driving the paging. */
function branchRows(count: number, from = 0) {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `cat-factory/blk_${from + index}`,
    commit: { sha: `sha-${from + index}` },
  }))
}

describe('addressing a ref', () => {
  it('encodes a slashed branch as a PATH, so the ref is the one the purge means', async () => {
    const calls: Call[] = []
    const api = github(
      { 'DELETE /repos/acme/catalog-api/git/refs/heads/cat-factory/blk_1': { status: 204 } },
      calls,
    )
    await api.deleteBranch(TARGET, 'cat-factory/blk_1')
    expect(calls[0]?.path).toBe('/repos/acme/catalog-api/git/refs/heads/cat-factory/blk_1')
    expect(calls[0]?.path).not.toContain('%2F')
  })

  it('still encodes what is not a separator', async () => {
    const calls: Call[] = []
    const api = github({}, calls)
    await api.deleteBranch(TARGET, 'feat/a b').catch(() => {})
    expect(calls[0]?.path).toBe('/repos/acme/catalog-api/git/refs/heads/feat/a%20b')
  })

  it('reads a 404 on the default branch as a repository with no commits', async () => {
    const api = github({
      'GET /repos/acme/catalog-api': { status: 200, body: { default_branch: 'main' } },
      'GET /repos/acme/catalog-api/git/ref/heads/main': { status: 404 },
    })
    expect(await api.head(TARGET)).toBeNull()
  })
})

describe('creating a backup tag', () => {
  const created = { 'POST /repos/acme/catalog-api/git/refs': { status: 201 } }

  it('accepts the create', async () => {
    await expect(
      github(created).createTag(TARGET, 'cf-acc-reset/s/main-abc', 'tip'),
    ).resolves.toBeUndefined()
  })

  // The only 422 that means "the backup this call wanted is already there".
  it('accepts a 422 whose tag already points at the same sha', async () => {
    const api = github({
      'POST /repos/acme/catalog-api/git/refs': {
        status: 422,
        body: { message: 'Reference already exists' },
      },
      'GET /repos/acme/catalog-api/git/ref/tags/cf-acc-reset/s/main-abc': {
        status: 200,
        body: { object: { sha: 'tip' } },
      },
    })
    await expect(api.createTag(TARGET, 'cf-acc-reset/s/main-abc', 'tip')).resolves.toBeUndefined()
  })

  // A tag at a DIFFERENT sha is not a backup of this ref: two branches that collided on one name
  // would otherwise have the second recorded as backed up at the first one's commit.
  it('refuses a 422 whose tag points somewhere else', async () => {
    const api = github({
      'POST /repos/acme/catalog-api/git/refs': { status: 422 },
      'GET /repos/acme/catalog-api/git/ref/tags/cf-acc-reset/s/main-abc': {
        status: 200,
        body: { object: { sha: 'somewhere-else' } },
      },
    })
    await expect(api.createTag(TARGET, 'cf-acc-reset/s/main-abc', 'tip')).rejects.toThrow(
      /already exists .* at somewhere-else/s,
    )
  })

  // "Object does not exist", a name git rejects: 422 with no tag to find afterwards. Read as
  // "already exists", this is the single unrecoverable bug available in the purge.
  it('refuses a 422 with no such tag, carrying the provider’s own reason', async () => {
    const api = github({
      'POST /repos/acme/catalog-api/git/refs': {
        status: 422,
        body: { message: 'Reference cannot be created' },
      },
      'GET /repos/acme/catalog-api/git/ref/tags/cf-acc-reset/s/main-abc': { status: 404 },
    })
    await expect(api.createTag(TARGET, 'cf-acc-reset/s/main-abc', 'tip')).rejects.toThrow(
      /Reference cannot be created/,
    )
  })
})

describe('listing what a purge acts on', () => {
  it('reads branches past the first page', async () => {
    const api = github({
      'GET /repos/acme/catalog-api/branches?per_page=100&page=1': {
        status: 200,
        body: branchRows(100),
      },
      'GET /repos/acme/catalog-api/branches?per_page=100&page=2': {
        status: 200,
        body: branchRows(7, 100),
      },
    })
    const branches = await api.branches(TARGET)
    expect(branches).toHaveLength(107)
    expect(branches.at(-1)?.name).toBe('cat-factory/blk_106')
  })

  it('reads open pull requests past the first page, keeping the existing query', async () => {
    const api = github({
      'GET /repos/acme/catalog-api/pulls?state=open&per_page=100&page=1': {
        status: 200,
        body: Array.from({ length: 100 }, (_unused, index) => ({ number: index + 1 })),
      },
      'GET /repos/acme/catalog-api/pulls?state=open&per_page=100&page=2': {
        status: 200,
        body: [{ number: 101 }],
      },
    })
    expect(await api.openPullRequests(TARGET)).toHaveLength(101)
  })

  it('stops at a short page rather than asking for one more', async () => {
    const calls: Call[] = []
    const api = github(
      {
        'GET /repos/acme/catalog-api/branches?per_page=100&page=1': {
          status: 200,
          body: branchRows(2),
        },
      },
      calls,
    )
    await api.branches(TARGET)
    expect(calls).toHaveLength(1)
  })
})
