import type { RepoOp, RepoOpContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { runRepoOps } from './run.js'

const ctx = {} as unknown as RepoOpContext

describe('runRepoOps', () => {
  it('concatenates contextFiles across ops and keeps the last pullRequest', async () => {
    const opA: RepoOp = async () => ({ contextFiles: [{ path: 'a.md', content: 'A' }] })
    const opB: RepoOp = async () => ({
      contextFiles: [{ path: 'b.md', content: 'B' }],
      pullRequest: { url: 'u', number: 1, branch: 'br' },
    })
    const merged = await runRepoOps([opA, opB], ctx)
    expect(merged.contextFiles).toEqual([
      { path: 'a.md', content: 'A' },
      { path: 'b.md', content: 'B' },
    ])
    expect(merged.pullRequest?.number).toBe(1)
  })

  it('leaves the result empty when ops report nothing', async () => {
    const noop: RepoOp = async () => undefined
    expect(await runRepoOps([noop], ctx)).toEqual({})
  })
})
