import { describe, expect, it } from 'vitest'
import {
  applyRepoPurge,
  backupTagName,
  isKeptPath,
  planRepoPurge,
  recoveryLines,
  type RepoContentApi,
  type RepoPurgePlan,
  repoPurgeSucceeded,
} from '../src/repoPurge.ts'

// What is pinned here is RECOVERABILITY, because it is the whole reason this command is allowed to
// exist: the two repositories are named in a `.env`, a `.env` can name the wrong thing, and the
// failure being guarded against is an operator emptying a repository that mattered. Three properties
// carry it and each has a case below: the emptying commit is PARENTED on the previous tip, every ref
// is TAGGED before it is touched, and a backup that does not land STOPS the destructive half.

const target = { owner: 'acme', repo: 'catalog-api' }

type Call = { name: string; detail: string }

/** A recording double. Every call is appended, so a test can assert the ORDER of the writes. */
function api(overrides: Partial<RepoContentApi> = {}): RepoContentApi & { calls: Call[] } {
  const calls: Call[] = []
  const record = (name: string, detail = '') => void calls.push({ name, detail })
  const base: RepoContentApi = {
    head: async () => ({ branch: 'main', commitSha: 'tip-sha' }),
    rootEntries: async () => ['README.md', 'src', 'package.json'],
    branches: async () => [
      { name: 'main', commitSha: 'tip-sha' },
      { name: 'feat/catalog', commitSha: 'feat-sha' },
    ],
    openPullRequests: async () => [{ number: 4, title: 'Catalog', headBranch: 'feat/catalog' }],
    createTag: async (_t, tag, sha) => record('createTag', `${tag}@${sha}`),
    commitKeepingOnly: async (_t, commit) => {
      record('commitKeepingOnly', `parent=${commit.parentSha} keep=${commit.keepPaths.join('+')}`)
      return 'new-sha'
    },
    updateBranch: async (_t, branch, sha) => record('updateBranch', `${branch}=${sha}`),
    closePullRequest: async (_t, number) => record('closePullRequest', `#${number}`),
    deleteBranch: async (_t, branch) => record('deleteBranch', branch),
  }
  return { ...base, ...overrides, calls }
}

async function planned(client: RepoContentApi): Promise<RepoPurgePlan> {
  return planRepoPurge(client, target, '20260812T1200')
}

describe('isKeptPath', () => {
  // The operator was told to create the repository "with a README and nothing else", and a provider
  // renders several spellings of it. Keeping only `README.md` would delete the one file named.
  it('keeps a README whatever its spelling, and nothing else', () => {
    for (const kept of ['README.md', 'readme.md', 'README', 'Readme.rst', 'README.txt']) {
      expect(isKeptPath(kept)).toBe(true)
    }
    for (const removed of ['src', 'package.json', 'READMEISH.md', 'docs/README.md']) {
      expect(isKeptPath(removed)).toBe(false)
    }
  })
})

describe('planRepoPurge', () => {
  it('separates what goes from what stays, and names a backup for every ref it will touch', async () => {
    const plan = await planned(api())
    expect(plan.keepPaths).toEqual(['README.md'])
    expect(plan.removePaths).toEqual(['src', 'package.json'])
    expect(plan.deleteBranches.map((branch) => branch.name)).toEqual(['feat/catalog'])
    expect(plan.closePullRequests.map((pull) => pull.number)).toEqual([4])
    // The default branch AND the branch about to be deleted, each at the sha it holds now.
    expect(plan.backups).toEqual([
      { tag: backupTagName('20260812T1200', 'main'), branch: 'main', commitSha: 'tip-sha' },
      {
        tag: backupTagName('20260812T1200', 'feat/catalog'),
        branch: 'feat/catalog',
        commitSha: 'feat-sha',
      },
    ])
    expect(plan.alreadyEmpty).toBe(false)
  })

  it('reads a repository with no commits as nothing to empty rather than as a failure', async () => {
    const plan = await planned(api({ head: async () => null }))
    expect(plan.head).toBeNull()
    expect(plan.alreadyEmpty).toBe(true)
    expect(plan.backups).toEqual([])
  })

  it('calls a README-only repository with no branches or pull requests already empty', async () => {
    const plan = await planned(
      api({
        rootEntries: async () => ['README.md'],
        branches: async () => [{ name: 'main', commitSha: 'tip-sha' }],
        openPullRequests: async () => [],
      }),
    )
    expect(plan.alreadyEmpty).toBe(true)
  })

  // A branch or an open pull request still makes a repository non-empty even when the TREE is clean,
  // and reporting it as already-empty would leave both behind under a report saying it was done.
  it('is not already empty when only the tree is clean', async () => {
    const plan = await planned(api({ rootEntries: async () => ['README.md'] }))
    expect(plan.alreadyEmpty).toBe(false)
    expect(plan.removePaths).toEqual([])
  })
})

describe('backupTagName', () => {
  it('flattens a slash, which would otherwise make a nested tag namespace', () => {
    expect(backupTagName('S', 'feat/catalog')).toMatch(
      /^cf-acc-reset\/S\/feat-catalog-[0-9a-f]{8}$/,
    )
  })

  // Flattening ALONE maps these onto one tag. The provider answers the second create with the same
  // 422 it answers "already exists" with, and a purge that read that as a landed backup would delete
  // the second branch with nothing but the FIRST branch's sha named anywhere.
  it('keeps two branches that flatten alike on separate tags', () => {
    expect(backupTagName('S', 'cat-factory/x')).not.toBe(backupTagName('S', 'cat-factory-x'))
  })

  // Every one of these is a name git refuses outright, and the refusal arrives as the same 422.
  it('produces a name git accepts, whatever the branch was called', () => {
    for (const branch of ['feat/x..y', 'wip*', 'a b~c^d:e', '.hidden', 'release.lock', 'q?[x]']) {
      const tag = backupTagName('20260812', branch)
      const [, , component] = tag.split('/')
      expect(tag.startsWith('cf-acc-reset/20260812/')).toBe(true)
      expect(component).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(component).not.toContain('..')
      expect(component?.startsWith('.')).toBe(false)
      expect(component?.endsWith('.lock')).toBe(false)
    }
  })
})

describe('applyRepoPurge', () => {
  it('tags every ref BEFORE it writes or deletes anything', async () => {
    const client = api()
    await applyRepoPurge(client, await planned(client))
    const order = client.calls.map((call) => call.name)
    const lastTag = order.lastIndexOf('createTag')
    const firstWrite = Math.min(
      ...['commitKeepingOnly', 'updateBranch', 'closePullRequest', 'deleteBranch']
        .map((name) => order.indexOf(name))
        .filter((index) => index !== -1),
    )
    expect(lastTag).toBeLessThan(firstWrite)
  })

  it('parents the emptying commit on the previous tip, which is what makes it revertible', async () => {
    const client = api()
    const report = await applyRepoPurge(client, await planned(client))
    expect(client.calls).toContainEqual({
      name: 'commitKeepingOnly',
      detail: 'parent=tip-sha keep=README.md',
    })
    // And the branch is moved to the new commit, never to anything else.
    expect(client.calls).toContainEqual({ name: 'updateBranch', detail: 'main=new-sha' })
    expect(report.outcome).toEqual({ status: 'emptied', commitSha: 'new-sha' })
    expect(report.previousSha).toBe('tip-sha')
  })

  it('commits before moving the ref, so a failed commit cannot move the branch', async () => {
    const client = api()
    await applyRepoPurge(client, await planned(client))
    const order = client.calls.map((call) => call.name)
    expect(order.indexOf('commitKeepingOnly')).toBeLessThan(order.indexOf('updateBranch'))
  })

  // The one case that must never destroy anything: with no backup written, the purge has no way to
  // offer recovery, so neither the tree nor a branch is touched.
  it('destroys nothing when no backup tag can be created', async () => {
    const client = api({
      createTag: async () => {
        throw new Error('refs are protected')
      },
    })
    const report = await applyRepoPurge(client, await planned(client))
    expect(report.outcome.status).toBe('failed')
    expect(client.calls.map((call) => call.name)).not.toContain('commitKeepingOnly')
    expect(client.calls.map((call) => call.name)).not.toContain('deleteBranch')
    expect(repoPurgeSucceeded([report])).toBe(false)
  })

  // Each backup is the precondition of the write it protects, and no more than that. Aborting the
  // repository on the first failed tag made this branch of the code unreachable: the guard below is
  // the only thing standing between a missing backup and an unrecoverable delete, so it has to be
  // reachable in the state it was written for.
  it('leaves a branch in place when its own backup tag did not land, and empties the tree anyway', async () => {
    const client = api({
      createTag: async (_t, tag) => {
        if (tag.includes('feat-catalog')) throw new Error('nope')
      },
    })
    const report = await applyRepoPurge(client, await planned(client))
    // The emptying commit is revertible on its own, and the default branch's own tag landed.
    expect(report.outcome).toEqual({ status: 'emptied', commitSha: 'new-sha' })
    expect(client.calls.map((call) => call.name)).not.toContain('deleteBranch')
    expect(report.problems.join('\n')).toContain('unrecoverable')
    expect(repoPurgeSucceeded([report])).toBe(false)
  })

  // The mirror image: the default branch's tag is the one that fails, so the TREE is left as it is
  // while the branch whose backup did land is still deletable.
  it('leaves the tree alone when the default branch was not backed up', async () => {
    const client = api({
      createTag: async (_t, tag) => {
        if (tag.includes('main')) throw new Error('protected')
      },
    })
    const report = await applyRepoPurge(client, await planned(client))
    expect(report.outcome.status).toBe('failed')
    expect(client.calls.map((call) => call.name)).not.toContain('commitKeepingOnly')
    expect(client.calls.map((call) => call.name)).toContain('deleteBranch')
  })

  it('closes a pull request before deleting the branch it is open against', async () => {
    const client = api()
    await applyRepoPurge(client, await planned(client))
    const order = client.calls.map((call) => call.name)
    expect(order.indexOf('closePullRequest')).toBeLessThan(order.indexOf('deleteBranch'))
  })

  it('collects a failed branch delete instead of stopping, and reports it as a failure', async () => {
    const client = api({
      deleteBranch: async () => {
        throw new Error('branch is protected')
      },
    })
    const report = await applyRepoPurge(client, await planned(client))
    expect(report.outcome).toEqual({ status: 'emptied', commitSha: 'new-sha' })
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toContain('feat/catalog')
    expect(repoPurgeSucceeded([report])).toBe(false)
  })

  // The emptying is expressed as a tree listing what STAYS, so a repository with nothing to keep has
  // no such tree to write: the provider rejects an empty one. Refused where the condition is known
  // rather than discovered after the backup tags have been written.
  it('refuses a repository with no README at the root, before writing anything', async () => {
    const client = api({ rootEntries: async () => ['src', 'package.json'] })
    const plan = await planned(client)
    expect(plan.refusal).toContain('no README')
    const report = await applyRepoPurge(client, plan)
    expect(report.outcome.status).toBe('failed')
    expect(client.calls).toEqual([])
    expect(repoPurgeSucceeded([report])).toBe(false)
  })

  it('writes nothing at all to an already-empty repository', async () => {
    const client = api({
      rootEntries: async () => ['README.md'],
      branches: async () => [{ name: 'main', commitSha: 'tip-sha' }],
      openPullRequests: async () => [],
    })
    const report = await applyRepoPurge(client, await planned(client))
    expect(report.outcome).toEqual({ status: 'already-empty' })
    expect(client.calls).toEqual([])
  })
})

describe('recoveryLines', () => {
  it('names both the commit and the sha to reset to, so recovery needs nothing else', async () => {
    const client = api()
    const report = await applyRepoPurge(client, await planned(client))
    const text = recoveryLines(report).join('\n')
    expect(text).toContain('git revert new-sha')
    expect(text).toContain('git reset --hard tip-sha')
    // And the tags, which are the only route back to a branch that was deleted.
    expect(text).toContain(backupTagName('20260812T1200', 'feat/catalog'))
  })

  it('still names the backups when nothing was emptied', async () => {
    const client = api({
      commitKeepingOnly: async () => {
        throw new Error('tree write refused')
      },
    })
    const report = await applyRepoPurge(client, await planned(client))
    expect(recoveryLines(report).join('\n')).toContain(backupTagName('20260812T1200', 'main'))
  })

  // A refused commit does not stop the deletes, which have backups of their own, so "nothing was
  // emptied" would send an operator away from the one recovery they need.
  it('names the branches it deleted even though the tree write refused', async () => {
    const client = api({
      commitKeepingOnly: async () => {
        throw new Error('tree write refused')
      },
    })
    const report = await applyRepoPurge(client, await planned(client))
    const text = recoveryLines(report).join('\n')
    expect(text).toContain('feat/catalog')
    expect(text).toContain(backupTagName('20260812T1200', 'feat/catalog'))
  })
})
