import { describe, expect, it, vi } from 'vitest'
import type { AgentRunContext, GitHubClient, RepoOp, RepoOpContext } from '@cat-factory/kernel'
import { makeRepoFiles, makeResolveRepoFiles, runRepoOps } from './repoFiles.js'

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

describe('runRepoOps', () => {
  const ctx = (): RepoOpContext => ({
    repo: makeRepoFiles(fakeClient(), 1, REF),
    context: {
      agentKind: 'x',
      block: { title: 't', type: 'service', description: '' },
    } as AgentRunContext,
    branch: 'main',
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
