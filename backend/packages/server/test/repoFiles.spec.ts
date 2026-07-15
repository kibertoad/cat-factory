import { describe, expect, it, vi } from 'vitest'
import type {
  AgentRunContext,
  CachedRepoRead,
  GitHubClient,
  GroupCacheHandle,
  RepoOp,
  RepoOpContext,
} from '@cat-factory/kernel'
import { makeRepoFiles, makeResolveRepoFiles, runRepoOps } from '../src/agents/repoFiles.js'

const REF = { owner: 'acme', repo: 'widgets' }

/** A partial GitHubClient recording the git-data calls RepoFiles delegates to. */
function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const base = {
    getFileContent: vi.fn(async () => ({ content: 'baseline', sha: 'blob1' })),
    listDirectory: vi.fn(async () => [
      { path: 'spec/features/a.feature', name: 'a.feature', type: 'file', sha: 's' },
    ]),
    branchHeadSha: vi.fn(async (_inst: number, _ref: unknown, branch: string) =>
      branch === 'main' ? 'sha-main' : branch === 'cat-factory/blk' ? 'sha-work' : null,
    ),
    createBranch: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
    commitFiles: vi.fn(async () => ({ sha: 'commit1' })),
    openPullRequest: vi.fn(async () => ({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
    })),
    ...overrides,
  }
  return base as unknown as GitHubClient
}

describe('makeRepoFiles', () => {
  it('delegates reads to the bound installation + repo', async () => {
    const client = fakeClient()
    const repo = makeRepoFiles(client, 42, REF)

    await repo.getFile('spec/spec.json', 'cat-factory/blk')
    expect(client.getFileContent).toHaveBeenCalledWith(42, REF, 'spec/spec.json', 'cat-factory/blk')

    await repo.listDirectory('spec/features')
    expect(client.listDirectory).toHaveBeenCalledWith(42, REF, 'spec/features', undefined)
  })

  it('resolves a branch head sha via the exact single-ref lookup, or null when absent', async () => {
    const client = fakeClient()
    const repo = makeRepoFiles(client, 42, REF)
    expect(await repo.headSha('cat-factory/blk')).toBe('sha-work')
    expect(await repo.headSha('does-not-exist')).toBeNull()
    // Uses the exact per-branch lookup, not the first-page-only `listBranches` projection
    // (which would miss a branch beyond page one in a repo with many branches).
    expect(client.branchHeadSha).toHaveBeenCalledWith(42, REF, 'cat-factory/blk')
  })

  it('delegates writes (createBranch / commitFiles / openPullRequest)', async () => {
    const client = fakeClient()
    const repo = makeRepoFiles(client, 42, REF)

    await repo.createBranch('cat-factory/blk', 'sha-main')
    expect(client.createBranch).toHaveBeenCalledWith(42, REF, 'cat-factory/blk', 'sha-main')

    const result = await repo.commitFiles({
      branch: 'cat-factory/blk',
      message: 'Update spec',
      files: [{ path: 'spec/spec.json', content: '{}' }],
    })
    expect(result.sha).toBe('commit1')
    expect(client.commitFiles).toHaveBeenCalledWith(42, REF, {
      branch: 'cat-factory/blk',
      message: 'Update spec',
      files: [{ path: 'spec/spec.json', content: '{}' }],
    })

    const pr = await repo.openPullRequest({ title: 'T', head: 'cat-factory/blk', base: 'main' })
    expect(pr.number).toBe(7)
  })

  it('makeResolveRepoFiles binds per (installation, ref)', async () => {
    const client = fakeClient()
    const resolve = makeResolveRepoFiles(client)
    await resolve(99, REF).getFile('x')
    expect(client.getFileContent).toHaveBeenCalledWith(99, REF, 'x', undefined)
  })
})

// A tiny in-memory `repoFiles` cache stand-in. It records the load + probe per (group, key)
// so a test can drive the refresh-window probe deterministically via `runProbes()` (the real
// timing behaviour lives in @cat-factory/caching's suite). Read-through with the same
// contract the wrapper relies on: a hit re-runs neither the load nor the client.
function fakeRepoFilesCache(): GroupCacheHandle<CachedRepoRead> & {
  runProbes: () => Promise<void>
  runProbesConcurrent: () => Promise<void>
} {
  const store = new Map<
    string,
    {
      value: CachedRepoRead
      load: () => Promise<CachedRepoRead>
      probe?: (c: CachedRepoRead) => Promise<boolean>
    }
  >()
  const id = (key: string, group: string) => `${group} ${key}`
  return {
    async get(key, group, load, isStillCurrent) {
      const k = id(key, group)
      const existing = store.get(k)
      if (existing) {
        existing.load = load
        existing.probe = isStillCurrent
        return existing.value
      }
      const value = await load()
      store.set(k, { value, load, probe: isStillCurrent })
      return value
    },
    async invalidate(key, group) {
      store.delete(id(key, group))
    },
    async invalidateGroup(group) {
      for (const k of Array.from(store.keys())) if (k.startsWith(`${group} `)) store.delete(k)
    },
    async invalidateAll() {
      store.clear()
    },
    // Simulate an entry entering its refresh window: probe, reload on a stale/absent probe.
    async runProbes() {
      for (const entry of store.values()) {
        if (entry.probe && !(await entry.probe(entry.value))) entry.value = await entry.load()
      }
    },
    // Same, but fire every entry's probe CONCURRENTLY (as a refresh sweep of a whole branch
    // group does), so the wrapper's per-branch probe-head coalescing is exercised.
    async runProbesConcurrent() {
      const entries = Array.from(store.values())
      const verdicts = await Promise.all(
        entries.map((e) => (e.probe ? e.probe(e.value) : Promise.resolve(true))),
      )
      await Promise.all(
        entries.map(async (e, i) => {
          if (!verdicts[i]) e.value = await e.load()
        }),
      )
    },
  }
}

describe('makeRepoFiles (cached, slice 4)', () => {
  it('reads a branch file through the cache — a second read hits neither client nor a re-load', async () => {
    const client = fakeClient()
    const repo = makeRepoFiles(client, 42, REF, fakeRepoFilesCache())

    const first = await repo.getFile('spec/a.json', 'cat-factory/blk')
    const second = await repo.getFile('spec/a.json', 'cat-factory/blk')
    expect(first).toEqual({ content: 'baseline', sha: 'blob1' })
    expect(second).toEqual(first)
    expect(client.getFileContent).toHaveBeenCalledTimes(1)
  })

  it('reads the branch head once per batch (memoised), stamping it on every entry for the probe', async () => {
    const client = fakeClient()
    const cache = fakeRepoFilesCache()
    const repo = makeRepoFiles(client, 42, REF, cache)

    await repo.getFile('spec/a.json', 'cat-factory/blk')
    await repo.getFile('spec/b.json', 'cat-factory/blk')
    await repo.listDirectory('spec', 'cat-factory/blk')
    // One head read stamps all three entries — not one per file.
    expect(client.branchHeadSha).toHaveBeenCalledTimes(1)

    // Head unchanged ⇒ the probe keeps every entry (no re-fetch) when the refresh window fires.
    await cache.runProbes()
    expect(client.getFileContent).toHaveBeenCalledTimes(2)
    expect(client.listDirectory).toHaveBeenCalledTimes(1)
  })

  it('the head-sha probe re-fetches when the branch has moved', async () => {
    let head = 'sha-work'
    const client = fakeClient({
      branchHeadSha: vi.fn(async () => head),
      getFileContent: vi.fn(async () => ({ content: head, sha: head })),
    })
    const cache = fakeRepoFilesCache()
    const repo = makeRepoFiles(client, 42, REF, cache)

    expect((await repo.getFile('spec/a.json', 'cat-factory/blk'))?.content).toBe('sha-work')
    head = 'sha-moved' // an out-of-band push advanced the branch
    await cache.runProbes()
    expect((await repo.getFile('spec/a.json', 'cat-factory/blk'))?.content).toBe('sha-moved')
  })

  it('commitFiles invalidates the branch group so the next read re-fetches', async () => {
    const client = fakeClient()
    const cache = fakeRepoFilesCache()
    const repo = makeRepoFiles(client, 42, REF, cache)

    await repo.getFile('spec/a.json', 'cat-factory/blk')
    await repo.commitFiles({ branch: 'cat-factory/blk', message: 'm', files: [] })
    await repo.getFile('spec/a.json', 'cat-factory/blk')
    expect(client.getFileContent).toHaveBeenCalledTimes(2) // cache dropped by the commit
    // A different branch's entry is untouched by the commit's group invalidation.
    await repo.getFile('spec/a.json', 'main')
    await repo.getFile('spec/a.json', 'main')
    expect(client.getFileContent).toHaveBeenCalledTimes(3)
  })

  it('a sha-pinned read is immutable: the probe never reads a head and always keeps the entry', async () => {
    const sha = 'a'.repeat(40)
    const client = fakeClient()
    const cache = fakeRepoFilesCache()
    const repo = makeRepoFiles(client, 42, REF, cache)

    await repo.getFile('spec/a.json', sha)
    await cache.runProbes()
    await repo.getFile('spec/a.json', sha)
    expect(client.getFileContent).toHaveBeenCalledTimes(1) // never re-fetched
    expect(client.branchHeadSha).not.toHaveBeenCalled() // pinned ⇒ no head read at all
  })

  it('a read with no gitRef (default branch) bypasses the cache', async () => {
    const client = fakeClient()
    const repo = makeRepoFiles(client, 42, REF, fakeRepoFilesCache())
    await repo.getFile('README.md')
    await repo.getFile('README.md')
    expect(client.getFileContent).toHaveBeenCalledTimes(2) // uncached — served live each time
  })

  it('coalesces a concurrent refresh sweep on one branch to a single head read', async () => {
    const client = fakeClient()
    const cache = fakeRepoFilesCache()
    const repo = makeRepoFiles(client, 42, REF, cache)

    // Cold-load three shards on one branch: one head read stamps all three (the load memo).
    await repo.getFile('spec/a.json', 'cat-factory/blk')
    await repo.getFile('spec/b.json', 'cat-factory/blk')
    await repo.listDirectory('spec', 'cat-factory/blk')
    expect(client.branchHeadSha).toHaveBeenCalledTimes(1)

    // A refresh window fires all three probes at once. They share ONE current-head read, not
    // one per entry — so a branch with many shards costs +1 head read per sweep, not +N.
    await cache.runProbesConcurrent()
    expect(client.branchHeadSha).toHaveBeenCalledTimes(2)
  })

  it('a transient head-read failure degrades to a live content read instead of failing the batch', async () => {
    let failHead = true
    const client = fakeClient({
      branchHeadSha: vi.fn(async () => {
        if (failHead) throw new Error('transient 5xx')
        return 'sha-work'
      }),
    })
    const cache = fakeRepoFilesCache()
    const repo = makeRepoFiles(client, 42, REF, cache)

    // The head probe blips, but the content read still resolves — a cached read is no less
    // robust than the uncached path (which never read the head at all).
    const first = await repo.getFile('spec/a.json', 'cat-factory/blk')
    expect(first).toEqual({ content: 'baseline', sha: 'blob1' })

    // GitHub recovers. The rejected head promise was NOT memoised (it would have poisoned every
    // later read on the branch), so a second path re-reads the head afresh and succeeds.
    failHead = false
    const second = await repo.getFile('spec/b.json', 'cat-factory/blk')
    expect(second).toEqual({ content: 'baseline', sha: 'blob1' })
    expect(client.getFileContent).toHaveBeenCalledTimes(2)
    expect(client.branchHeadSha).toHaveBeenCalledTimes(2) // retried, not stuck on the rejection
  })
})

describe('runRepoOps', () => {
  const ctx = (): RepoOpContext => ({
    repo: makeRepoFiles(fakeClient(), 1, REF),
    context: {
      agentKind: 'x',
      block: { title: 't', type: 'service', description: '' },
    } as AgentRunContext,
    branch: 'main',
    opensPr: false,
  })

  it('runs ops in order', async () => {
    const calls: string[] = []
    const a: RepoOp = async () => void calls.push('a')
    const b: RepoOp = async () => void calls.push('b')
    await runRepoOps([a, b], ctx())
    expect(calls).toEqual(['a', 'b'])
  })

  it('aborts on a throwing op and propagates', async () => {
    const calls: string[] = []
    const a: RepoOp = async () => void calls.push('a')
    const boom: RepoOp = async () => {
      throw new Error('boom')
    }
    const c: RepoOp = async () => void calls.push('c')
    await expect(runRepoOps([a, boom, c], ctx())).rejects.toThrow('boom')
    expect(calls).toEqual(['a']) // c never ran
  })
})
