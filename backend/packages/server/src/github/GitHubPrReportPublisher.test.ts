import type { Block, BlockRepository, GitHubClient, PrReportTarget } from '@cat-factory/kernel'
import { createRecordingLogger, readManagedSection } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { RepoTarget } from '../agents/ContainerAgentExecutor.js'
import type { GitHubPrReportPublisherDependencies } from './GitHubPrReportPublisher.js'
import { GitHubPrReportPublisher } from './GitHubPrReportPublisher.js'

const BLOCK_WITH_PR = {
  id: 'blk_1',
  pullRequest: { number: 7, url: 'https://github.test/o/r/pull/7', branch: 'work' },
} as unknown as Block

/**
 * A cross-service task (service-connections phase 3): the run opened its own-service PR plus one
 * in a connected service's repo, each attributed to the involved frame it came from.
 */
const BLOCK_MULTI_REPO = {
  id: 'blk_1',
  pullRequest: { number: 7, url: 'https://github.test/o/r/pull/7', branch: 'work' },
  involvedServiceIds: ['frm_email'],
  peerPullRequests: [
    {
      repo: 'o/email',
      frameIds: ['frm_email'],
      ref: { number: 12, url: 'https://github.test/o/email/pull/12', branch: 'work' },
    },
  ],
} as unknown as Block

const OWN_REPO: RepoTarget = {
  installationId: 1,
  repoId: '1001',
  owner: 'o',
  name: 'r',
  baseBranch: 'main',
}
const PEER_REPO: RepoTarget = {
  installationId: 1,
  repoId: '1002',
  owner: 'o',
  name: 'email',
  baseBranch: 'main',
}

/**
 * A fake VCS client keeping one body PER REPO, so a multi-repo test can prove each PR got its
 * own section rather than one body standing in for all of them.
 */
function makeDeps(block: Block | null, body: string | null) {
  const updates: { installationId: number; repo: string; number: number; body?: string }[] = []
  const bodies = new Map<string, string | null>([
    ['o/r', body],
    ['o/email', body],
  ])
  const key = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`
  const githubClient = {
    getPullRequestBody: async (_i: number, ref: { owner: string; repo: string }) =>
      bodies.get(key(ref)) ?? null,
    updatePullRequest: async (
      installationId: number,
      ref: { owner: string; repo: string },
      number: number,
      patch: { body?: string },
    ) => {
      updates.push({ installationId, repo: key(ref), number, body: patch.body })
      bodies.set(key(ref), patch.body ?? bodies.get(key(ref)) ?? null)
      return {} as never
    },
  } as unknown as GitHubClient
  return {
    updates,
    body: (repo = 'o/r') => bodies.get(repo) ?? null,
    deps: {
      githubClient,
      resolveRepoTarget: async () => OWN_REPO,
      resolveRepoTargets: async () => ({
        checkouts: [
          { target: OWN_REPO, primary: true, involved: [] },
          { target: PEER_REPO, primary: false, involved: [{ frameId: 'frm_email' }] },
        ],
      }),
      blockRepository: { get: async () => block } as unknown as BlockRepository,
    } satisfies GitHubPrReportPublisherDependencies,
  }
}

/**
 * A target as `resolveTargets` hands it back: self-describing, so the write needs nothing else.
 * `connectionId` is the workspace's installation id, stringified into the neutral vocabulary.
 */
const ownTarget: PrReportTarget = {
  prNumber: 7,
  repo: 'o/r',
  provider: 'github',
  connection: { provider: 'github', connectionId: '1' },
  role: 'own',
}
const peerTarget: PrReportTarget = {
  prNumber: 12,
  repo: 'o/email',
  provider: 'github',
  connection: { provider: 'github', connectionId: '1' },
  role: 'peer',
  frameIds: ['frm_email'],
}

describe('GitHubPrReportPublisher.resolveTargets', () => {
  it('reports the repo the PR actually lives in, defaulting the provider to GitHub', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    expect(await new GitHubPrReportPublisher(h.deps).resolveTargets('ws_1', 'blk_1')).toEqual([
      {
        prNumber: 7,
        repo: 'o/r',
        provider: 'github',
        connection: { provider: 'github', connectionId: '1' },
        role: 'own',
        url: 'https://github.test/o/r/pull/7',
      },
    ])
  })

  it("takes the provider from the deployment's origin resolver, never a hard-coded 'github'", async () => {
    // A GitLab deployment injects one origin builder; the report must state `gitlab` without
    // this adapter branching on provider at all.
    const h = makeDeps(BLOCK_WITH_PR, null)
    const targets = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoOrigin: () => ({ cloneUrl: 'https://gitlab.test/o/r.git', provider: 'gitlab' }),
    }).resolveTargets('ws_1', 'blk_1')
    expect(targets[0]?.provider).toBe('gitlab')
    // The CONNECTION names it too. A target that claimed `github` on a GitLab deployment would
    // mis-route the day a native GitLab publisher picks its adapter off this field.
    expect(targets[0]?.connection).toEqual({ provider: 'gitlab', connectionId: '1' })
  })

  it('resolves nothing when the block has no PR yet', async () => {
    const h = makeDeps({ id: 'blk_1' } as Block, null)
    expect(await new GitHubPrReportPublisher(h.deps).resolveTargets('ws_1', 'blk_1')).toEqual([])
  })

  it('resolves nothing when the block has no linked repo', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    const publisher = new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTarget: async () => null,
    })
    expect(await publisher.resolveTargets('ws_1', 'blk_1')).toEqual([])
  })

  it('resolves the own-service PR FIRST, then each peer repo’s', async () => {
    // Order is load-bearing: the engine reads the peer reports' back-pointer off the head of
    // this list rather than re-resolving which PR is the own-service one.
    const h = makeDeps(BLOCK_MULTI_REPO, null)
    const targets = await new GitHubPrReportPublisher(h.deps).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => [t.repo, t.prNumber, t.role])).toEqual([
      ['o/r', 7, 'own'],
      ['o/email', 12, 'peer'],
    ])
    expect(targets[1]?.frameIds).toEqual(['frm_email'])
  })

  it('names the involved services CO-LOCATED in the primary repo on the own-service target', async () => {
    // A monorepo hosting the task's own service and an involved one: the fan-out dedupes by
    // REPO, so there is no peer checkout and no second pull request. Their change rides the
    // own-service PR, and this report is the only place it is reported at all. An unnamed
    // co-located service reads exactly like one the run opened no pull request for.
    const block = {
      id: 'blk_1',
      pullRequest: { number: 7, url: 'https://github.test/o/r/pull/7', branch: 'work' },
      involvedServiceIds: ['frm_billing'],
    } as unknown as Block
    const h = makeDeps(block, null)
    const targets = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTargets: async () => ({
        checkouts: [{ target: OWN_REPO, primary: true, involved: [{ frameId: 'frm_billing' }] }],
      }),
    }).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => [t.repo, t.role, t.frameIds])).toEqual([
      ['o/r', 'own', ['frm_billing']],
    ])
  })

  it('leaves the own-service target unattributed on a single-repo run', async () => {
    // No involved service means no frame to name, which is what an absent `frameIds` says. The
    // resolution is skipped outright: a single-repo run must not pay for a repo read.
    const h = makeDeps(BLOCK_WITH_PR, null)
    let resolutions = 0
    const targets = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTargets: async () => {
        resolutions += 1
        return { checkouts: [{ target: OWN_REPO, primary: true, involved: [] }] }
      },
    }).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => t.frameIds)).toEqual([undefined])
    expect(resolutions).toBe(0)
  })

  it('attributes a peer PR from its resolved checkout when the record carries no frames', async () => {
    // The frames on a recorded peer PR can be absent (a row written before the attribution
    // existed, or echoed by an older harness image). The repo is what addresses the checkout,
    // and the frames that checkout hosts are the platform's own answer about what rides it,
    // off a resolution this call already paid for.
    const block = {
      ...BLOCK_MULTI_REPO,
      peerPullRequests: [
        { repo: 'o/email', ref: { number: 12, url: 'https://github.test/o/email/pull/12' } },
      ],
    } as unknown as Block
    const h = makeDeps(block, null)
    const targets = await new GitHubPrReportPublisher(h.deps).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => [t.role, t.frameIds])).toEqual([
      ['own', undefined],
      ['peer', ['frm_email']],
    ])
  })

  it('resolves a peer PR even when the own service has not opened one yet', async () => {
    // The coding agent can push a connected service's change first; that PR is owed a report,
    // and its own-service back-pointer is what says the other PR is not there yet.
    const block = { ...BLOCK_MULTI_REPO, pullRequest: undefined } as unknown as Block
    const h = makeDeps(block, null)
    const targets = await new GitHubPrReportPublisher(h.deps).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => t.role)).toEqual(['peer'])
  })

  it('skips a peer whose repo is not in the resolved checkout set', async () => {
    // Nothing supplies the connection to write through, so the PR is not addressable. Skipped
    // rather than guessed at: writing onto a pull request we cannot confirm is worse than not.
    const h = makeDeps(BLOCK_MULTI_REPO, null)
    const targets = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTargets: async () => ({
        checkouts: [{ target: OWN_REPO, primary: true, involved: [] }],
      }),
    }).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => t.role)).toEqual(['own'])
  })

  it('keeps the own-service target when PEER resolution throws, and logs why', async () => {
    // The multi-repo resolver throws on a workspace with no installation or an involved frame
    // that lost its repo linkage. Letting that propagate would cost the OWN-SERVICE report — the
    // one a reviewer is most likely reading — over a broken peer.
    const h = makeDeps(BLOCK_MULTI_REPO, null)
    const logger = createRecordingLogger()
    const targets = await new GitHubPrReportPublisher({
      ...h.deps,
      resolveRepoTargets: async () => {
        throw new Error('workspace has no GitHub installation')
      },
      logger,
    }).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => t.role)).toEqual(['own'])
    // Swallowed, never silent: this is the one best-effort path in the adapter.
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('never reads a repo-less PEER entry as the own-service one', async () => {
    // The own-service entry is identified by carrying no repo. A peer whose recorded repo is
    // empty carries one that is merely falsy, and mistaking it for the own-service PR would
    // publish that peer's number into the OWN repo — a report on a pull request nobody asked
    // about, in a repo it is not about.
    const block = {
      id: 'blk_1',
      peerPullRequests: [{ repo: '', frameIds: ['frm_email'], ref: { number: 12 } }],
    } as unknown as Block
    const h = makeDeps(block, null)
    const targets = await new GitHubPrReportPublisher(h.deps).resolveTargets('ws_1', 'blk_1')

    expect(targets).toEqual([])
  })

  it('resolves no peers when the multi-repo resolver is not wired', async () => {
    // A deployment with the involved-services fan-out off never opens a peer PR, so "cannot
    // resolve peers" and "has no peers" coincide.
    const h = makeDeps(BLOCK_MULTI_REPO, null)
    const { resolveRepoTargets: _omitted, ...rest } = h.deps
    const targets = await new GitHubPrReportPublisher(rest).resolveTargets('ws_1', 'blk_1')

    expect(targets.map((t) => t.role)).toEqual(['own'])
  })
})

describe('GitHubPrReportPublisher', () => {
  it('appends the section to the PR body, preserving the agent’s own description', async () => {
    const h = makeDeps(BLOCK_WITH_PR, 'Implements login.')
    const result = await new GitHubPrReportPublisher(h.deps).publish('ws_1', ownTarget, 'REPORT')

    expect(result).toEqual({ published: true, prNumber: 7 })
    expect(h.updates).toHaveLength(1)
    expect(h.body()!.startsWith('Implements login.')).toBe(true)
    expect(readManagedSection(h.body())).toBe('REPORT')
  })

  it('rewrites the managed region in place on a second publish (never appends a copy)', async () => {
    const h = makeDeps(BLOCK_WITH_PR, 'Implements login.')
    const publisher = new GitHubPrReportPublisher(h.deps)
    await publisher.publish('ws_1', ownTarget, 'FIRST')
    await publisher.publish('ws_1', ownTarget, 'SECOND')

    expect(h.updates).toHaveLength(2)
    expect(readManagedSection(h.body())).toBe('SECOND')
    expect(h.body()).not.toContain('FIRST')
    expect(h.body()!.startsWith('Implements login.')).toBe(true)
  })

  it('makes no remote write when the body already carries exactly this section', async () => {
    const h = makeDeps(BLOCK_WITH_PR, null)
    const publisher = new GitHubPrReportPublisher(h.deps)
    await publisher.publish('ws_1', ownTarget, 'SAME')
    const second = await publisher.publish('ws_1', ownTarget, 'SAME')

    expect(second).toEqual({ published: false, skipped: 'unchanged', prNumber: 7 })
    expect(h.updates).toHaveLength(1)
  })

  it('reads NOTHING to publish: the target carries its own address', async () => {
    // The property that keeps a run with N pull requests at ONE resolution per settlement. A
    // repository read here would be invisible in every other assertion (the write still lands)
    // and would scale with the number of PRs, which is the N+1 this codebase bans.
    const h = makeDeps(BLOCK_MULTI_REPO, null)
    const refuse = (what: string) => () => {
      throw new Error(`publish must not resolve ${what}`)
    }
    const result = await new GitHubPrReportPublisher({
      ...h.deps,
      blockRepository: { get: refuse('the block') } as unknown as BlockRepository,
      resolveRepoTarget: refuse('the own repo'),
      resolveRepoTargets: refuse('the repo set'),
    }).publish('ws_1', peerTarget, 'PEER-REPORT')

    expect(result).toEqual({ published: true, prNumber: 12 })
    expect(h.updates.map((u) => u.repo)).toEqual(['o/email'])
  })

  it('writes through the CONNECTION the target names, never a re-derived one', async () => {
    // GitHub's installation id rides `connectionId` (the neutral vocabulary). A second opinion
    // about which connection to use is how a peer repo's write would go out under the wrong
    // installation — which fails as a 404, i.e. as a report that silently stops appearing.
    const h = makeDeps(BLOCK_WITH_PR, null)
    await new GitHubPrReportPublisher(h.deps).publish(
      'ws_1',
      { ...ownTarget, connection: { provider: 'github', connectionId: '42' } },
      'REPORT',
    )

    expect(h.updates.map((u) => u.installationId)).toEqual([42])
  })

  it('writes each target onto ITS OWN pull request', async () => {
    // The engine composes a different section per target (a peer's copy withholds the
    // own-service-only sections), so the two must not land on the same body.
    const h = makeDeps(BLOCK_MULTI_REPO, null)
    const publisher = new GitHubPrReportPublisher(h.deps)
    await publisher.publish('ws_1', ownTarget, 'OWN-REPORT')
    await publisher.publish('ws_1', peerTarget, 'PEER-REPORT')

    expect(h.updates.map((u) => [u.repo, u.number])).toEqual([
      ['o/r', 7],
      ['o/email', 12],
    ])
    expect(readManagedSection(h.body('o/r'))).toBe('OWN-REPORT')
    expect(readManagedSection(h.body('o/email'))).toBe('PEER-REPORT')
  })
})
