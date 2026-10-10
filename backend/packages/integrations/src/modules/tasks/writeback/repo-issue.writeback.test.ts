import { describe, expect, it } from 'vitest'
import type { GitHubClient, GitHubInstallationRepository } from '@cat-factory/kernel'
import { createTaskWritebackContext } from '@cat-factory/kernel'
import { GitHubIssuesProvider } from '../GitHubIssuesProvider.js'
import { GitLabIssuesProvider } from '../GitLabIssuesProvider.js'

// The writeback capability of the two repo-backed sources, driven through the PROVIDERS rather
// than the factory, because what is being asserted is that each source declares it and reads
// through its own client and connection row.

interface Recorded {
  comments: { installationId: number; ref: string; number: number; body: string }[]
  prComments: { number: number; body: string }[]
  closed: { ref: string; number: number }[]
  labels: { number: number; label: string }[]
}

function client(over: Partial<GitHubClient> = {}): { client: GitHubClient; recorded: Recorded } {
  const recorded: Recorded = { comments: [], prComments: [], closed: [], labels: [] }
  const base = {
    commentOnIssue: async (
      installationId: number,
      ref: { owner: string; repo: string },
      number: number,
      body: string,
    ) => {
      recorded.comments.push({ installationId, ref: `${ref.owner}/${ref.repo}`, number, body })
    },
    // The PR/MR conversation method, recorded separately so a writeback that routed through it
    // by mistake shows up as the cross-post it would be on GitLab.
    comment: async (
      _i: number,
      _ref: { owner: string; repo: string },
      number: number,
      body: string,
    ) => {
      recorded.prComments.push({ number, body })
    },
    closeIssue: async (_i: number, ref: { owner: string; repo: string }, number: number) => {
      recorded.closed.push({ ref: `${ref.owner}/${ref.repo}`, number })
    },
    applyIssueLabel: async (
      _i: number,
      _ref: { owner: string; repo: string },
      number: number,
      label: string,
    ) => {
      recorded.labels.push({ number, label })
    },
    ...over,
  }
  return { client: base as unknown as GitHubClient, recorded }
}

/** An installations repo answering with one row for the workspace, carrying `provider`. */
function installations(
  row: { provider: string } | null,
  onRead?: () => void,
): GitHubInstallationRepository {
  return {
    getByWorkspace: async () => {
      onRead?.()
      return row ? ({ installationId: 42, ...row } as never) : null
    },
  } as unknown as GitHubInstallationRepository
}

/**
 * A fresh batch context per call site. Deliberately a FACTORY rather than a shared constant: the
 * context memoises the adapter's per-batch installation read, so a module-level one would let the
 * first test's connection answer every later test's.
 */
const ctx = () => createTaskWritebackContext({ workspaceId: 'ws_1', credentials: {} })

describe('GitHubIssuesProvider.writeback', () => {
  it('comments, closes and labels the issue its external id names', async () => {
    const gh = client()
    const provider = new GitHubIssuesProvider({
      githubClient: gh.client,
      installations: installations({ provider: 'github' }),
    })
    await provider.writeback.comment(ctx(), 'acme/web#7', 'hello')
    await provider.writeback.resolve!(ctx(), 'acme/web#7')
    await provider.writeback.markInProgress!(ctx(), 'acme/web#7', { label: 'bot-working' })
    // GitHub's issue comment IS `comment`: one number space, one comment API.
    expect(gh.recorded.prComments).toEqual([{ number: 7, body: 'hello' }])
    expect(gh.recorded.closed).toEqual([{ ref: 'acme/web', number: 7 }])
    expect(gh.recorded.labels).toEqual([{ number: 7, label: 'bot-working' }])
  })

  it('defaults the in-progress label when the schedule named none', async () => {
    const gh = client()
    const provider = new GitHubIssuesProvider({
      githubClient: gh.client,
      installations: installations({ provider: 'github' }),
    })
    await provider.writeback.markInProgress!(ctx(), 'acme/web#7', {})
    expect(gh.recorded.labels).toEqual([{ number: 7, label: 'in-progress' }])
  })

  it('THROWS for a workspace with no connection, rather than returning quietly', async () => {
    // Returning normally is the port's promise that the comment landed, and the parked-review
    // echo records its idempotency marker on that promise: a quiet return here would mark the
    // questions posted for an issue that never received them, permanently suppressing the retry
    // that reconnecting should produce.
    const gh = client()
    const provider = new GitHubIssuesProvider({
      githubClient: gh.client,
      installations: installations(null),
    })
    await expect(provider.writeback.comment(ctx(), 'acme/web#7', 'hi')).rejects.toThrow(
      /no GitHub connection/i,
    )
    expect(gh.recorded.prComments).toEqual([])
  })

  it('THROWS on an external id it cannot parse', async () => {
    const gh = client()
    const provider = new GitHubIssuesProvider({
      githubClient: gh.client,
      installations: installations({ provider: 'github' }),
    })
    await expect(provider.writeback.comment(ctx(), 'not-an-id', 'hi')).rejects.toThrow(
      /not a valid GitHub issue reference/,
    )
  })

  it('reads the workspace connection ONCE per batch, however many calls the batch makes', async () => {
    // The connection is workspace-invariant, and the caller fans out over a block's linked issues
    // taking two calls each on the merge hook. Reading it per call turns one unchanging row into
    // 2N reads, which is the repository-access rule this hoist exists for.
    let reads = 0
    const gh = client()
    const provider = new GitHubIssuesProvider({
      githubClient: gh.client,
      installations: installations({ provider: 'github' }, () => {
        reads += 1
      }),
    })
    const batch = ctx()
    await Promise.all([
      provider.writeback.comment(batch, 'acme/web#7', 'one'),
      provider.writeback.comment(batch, 'acme/web#8', 'two'),
    ])
    await provider.writeback.resolve!(batch, 'acme/web#7')
    expect(reads).toBe(1)
    expect(gh.recorded.prComments).toHaveLength(2)

    // A LATER batch asks again, so a reconnected installation is never hidden behind the memo.
    await provider.writeback.comment(ctx(), 'acme/web#9', 'three')
    expect(reads).toBe(2)
  })

  it('does not need the dedicated issue-comment method GitLab does', async () => {
    // GitHub declares `shared-with-pull-requests`, so a client that implements only `comment`
    // serves it: the separate method exists for the vendors where the two are NOT one call.
    const gh = client({ commentOnIssue: undefined })
    const provider = new GitHubIssuesProvider({
      githubClient: gh.client,
      installations: installations({ provider: 'github' }),
    })
    await provider.writeback.comment(ctx(), 'acme/web#7', 'hi')
    expect(gh.recorded.prComments).toEqual([{ number: 7, body: 'hi' }])
  })
})

describe('GitLabIssuesProvider.writeback', () => {
  function gitlabProvider(over: Partial<GitHubClient> = {}, provider = 'gitlab') {
    const gl = client(over)
    return {
      gl,
      provider: new GitLabIssuesProvider({
        gitlabClient: gl.client,
        installations: installations({ provider }),
      }),
    }
  }

  it('comments on the ISSUE, never on the merge request sharing its number', async () => {
    // The bug this capability exists to make unspellable: GitLab issues and MRs have separate
    // `iid` spaces and separate notes endpoints, so a writeback routed through the neutral
    // `comment` would land on whatever MR happens to carry the number.
    const { gl, provider } = gitlabProvider()
    await provider.writeback.comment(ctx(), 'acme/sub/web#12', 'hello')
    expect(gl.recorded.comments).toEqual([
      { installationId: 42, ref: 'acme/sub/web', number: 12, body: 'hello' },
    ])
    expect(gl.recorded.prComments).toEqual([])
  })

  it('keeps a nested subgroup path intact through close and label', async () => {
    const { gl, provider } = gitlabProvider()
    await provider.writeback.resolve!(ctx(), 'acme/sub/web#12')
    await provider.writeback.markInProgress!(ctx(), 'acme/sub/web#12', {})
    expect(gl.recorded.closed).toEqual([{ ref: 'acme/sub/web', number: 12 }])
    expect(gl.recorded.labels).toEqual([{ number: 12, label: 'in-progress' }])
  })

  it('refuses a workspace whose VCS connection is a GitHub one', async () => {
    // One row per workspace, so "connected to a VCS" and "connected to GitLab" are different
    // facts and only the second can write back to a GitLab issue.
    const { provider } = gitlabProvider({}, 'github')
    await expect(provider.writeback.comment(ctx(), 'acme/web#12', 'hi')).rejects.toThrow(
      /no GitLab connection/i,
    )
  })

  it('refuses to comment through a client with no dedicated issue-comment method', async () => {
    // Never a silent no-op and never a fall-through to `comment`, which addresses MERGE REQUESTS
    // here: the fall-through is the cross-post the declaration exists to make unspellable.
    const { gl, provider } = gitlabProvider({ commentOnIssue: undefined })
    await expect(provider.writeback.comment(ctx(), 'acme/web#12', 'hi')).rejects.toThrow(
      /cannot comment on issues/,
    )
    expect(gl.recorded.prComments).toEqual([])
  })

  it('refuses to mark in progress through a client that cannot apply a label', async () => {
    // Commenting-without-marking would leave the claim invisible: the next scan reads the issue
    // as one nobody took.
    const { provider } = gitlabProvider({ applyIssueLabel: undefined })
    await expect(provider.writeback.markInProgress!(ctx(), 'acme/web#12', {})).rejects.toThrow(
      /cannot apply an issue label/,
    )
  })
})
