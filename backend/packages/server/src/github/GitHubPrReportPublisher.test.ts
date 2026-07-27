import type { Block, BlockRepository, GitHubClient } from '@cat-factory/kernel'
import { readManagedSection } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubPrReportPublisher } from './GitHubPrReportPublisher.js'

const BLOCK_WITH_PR = {
  id: 'blk_1',
  pullRequest: { number: 7, url: 'https://github.test/o/r/pull/7', branch: 'work' },
} as unknown as Block

function makeDeps(block: Block | null, body: string | null) {
  const updates: { number: number; body?: string }[] = []
  let current = body
  const githubClient = {
    getPullRequestBody: async () => current,
    updatePullRequest: async (
      _i: number,
      _ref: unknown,
      number: number,
      patch: { body?: string },
    ) => {
      updates.push({ number, body: patch.body })
      current = patch.body ?? current
      return {} as never
    },
  } as unknown as GitHubClient
  return {
    updates,
    body: () => current,
    deps: {
      githubClient,
      resolveRepoTarget: async () =>
        ({ installationId: 1, repoId: '1001', owner: 'o', name: 'r' }) as never,
      blockRepository: { get: async () => block } as unknown as BlockRepository,
    },
  }
}

describe('GitHubPrReportPublisher.resolveTarget', () => {
  it('reports the repo the PR actually lives in, defaulting the provider to GitHub', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    expect(await new GitHubPrReportPublisher(h.deps).resolveTarget('ws_1', 'blk_1')).toEqual({
      prNumber: 7,
      repo: 'o/r',
      provider: 'github',
    })
  })

  it("takes the provider from the deployment's origin resolver, never a hard-coded 'github'", async () => {
    // A GitLab deployment injects one origin builder; the report must state `gitlab` without
    // this adapter branching on provider at all.
    const h = makeDeps(BLOCK_WITH_PR, null)
    const target = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoOrigin: () => ({ cloneUrl: 'https://gitlab.test/o/r.git', provider: 'gitlab' }),
    }).resolveTarget('ws_1', 'blk_1')
    expect(target?.provider).toBe('gitlab')
  })

  it('resolves nothing when the block has no PR yet', async () => {
    const h = makeDeps({ id: 'blk_1' } as Block, null)
    expect(await new GitHubPrReportPublisher(h.deps).resolveTarget('ws_1', 'blk_1')).toBeNull()
  })

  it('resolves nothing when the block has no linked repo', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    const publisher = new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTarget: async () => null,
    })
    expect(await publisher.resolveTarget('ws_1', 'blk_1')).toBeNull()
  })
})

describe('GitHubPrReportPublisher', () => {
  it('appends the section to the PR body, preserving the agent’s own description', async () => {
    const h = makeDeps(BLOCK_WITH_PR, 'Implements login.')
    const result = await new GitHubPrReportPublisher(h.deps).publish('ws_1', 'blk_1', 'REPORT')

    expect(result).toEqual({ published: true, prNumber: 7 })
    expect(h.updates).toHaveLength(1)
    expect(h.body()!.startsWith('Implements login.')).toBe(true)
    expect(readManagedSection(h.body())).toBe('REPORT')
  })

  it('rewrites the managed region in place on a second publish (never appends a copy)', async () => {
    const h = makeDeps(BLOCK_WITH_PR, 'Implements login.')
    const publisher = new GitHubPrReportPublisher(h.deps)
    await publisher.publish('ws_1', 'blk_1', 'FIRST')
    await publisher.publish('ws_1', 'blk_1', 'SECOND')

    expect(h.updates).toHaveLength(2)
    expect(readManagedSection(h.body())).toBe('SECOND')
    expect(h.body()).not.toContain('FIRST')
    expect(h.body()!.startsWith('Implements login.')).toBe(true)
  })

  it('makes no remote write when the body already carries exactly this section', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    const publisher = new GitHubPrReportPublisher(h.deps)
    await publisher.publish('ws_1', 'blk_1', 'SAME')
    const second = await publisher.publish('ws_1', 'blk_1', 'SAME')

    expect(second).toEqual({ published: false, skipped: 'unchanged', prNumber: 7 })
    expect(h.updates).toHaveLength(1)
  })

  it('skips (does not throw) when the block has no pull request yet', async () => {
    const h = makeDeps({ id: 'blk_1' } as Block, null)
    const result = await new GitHubPrReportPublisher(h.deps).publish('ws_1', 'blk_1', 'REPORT')

    expect(result).toEqual({ published: false, skipped: 'no_pull_request' })
    expect(h.updates).toHaveLength(0)
  })

  it('skips when the block’s repo cannot be resolved', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    const result = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTarget: async () => null as never,
    }).publish('ws_1', 'blk_1', 'REPORT')

    expect(result).toEqual({ published: false, skipped: 'no_repo', prNumber: 7 })
    expect(h.updates).toHaveLength(0)
  })
})
