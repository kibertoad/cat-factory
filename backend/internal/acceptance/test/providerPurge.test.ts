import { describe, expect, it } from 'vitest'
import {
  formatProviderPlan,
  formatProviderReport,
  planProviderPurge,
  type ProviderPurgeClients,
  providerPurgeSucceeded,
  runProviderPurge,
} from '../src/providerPurge.ts'
import type { RepoContentApi } from '../src/repoPurge.ts'
import type { IssueApi } from '../src/vcsIssues.ts'

// The composition of the two halves, and it owns three properties neither half can:
//
//   - a provider read that FAILS still leaves a plan to print, because the bare form of this command
//     is a PREVIEW an operator reads before deciding, and a stack trace above a plan that was never
//     rendered is the one output it must not produce;
//   - the report says what was DONE, not what the tree outcome was: the tree, the pull requests and
//     the branches are three writes with three preconditions;
//   - a pass whose files this reset keeps is told that the repositories it ran against are shared
//     and going, because the retention otherwise reads as a promise that it stays resumable.

const backend = { owner: 'acme', repo: 'catalog-api' }
const frontend = { owner: 'acme', repo: 'catalog-web' }

function issues(overrides: Partial<IssueApi> = {}): IssueApi {
  return {
    probe: async () => ({ status: 'ready' }),
    file: async () => ({ number: 0, url: '' }),
    read: async () => ({ state: 'open', closed: false, url: 'u', comments: [] }),
    listOpen: async () => [],
    close: async () => {},
    viewer: async () => 'acceptance-bot',
    ...overrides,
  }
}

function content(overrides: Partial<RepoContentApi> = {}): RepoContentApi {
  return {
    head: async () => ({ branch: 'main', commitSha: 'tip-sha' }),
    rootEntries: async () => ['README.md'],
    branches: async () => [
      { name: 'main', commitSha: 'tip-sha' },
      { name: 'cat-factory/blk_1', commitSha: 'feat-sha' },
    ],
    openPullRequests: async () => [
      { number: 4, title: 'Catalog', headBranch: 'cat-factory/blk_1' },
    ],
    createTag: async () => {},
    commitKeepingOnly: async () => 'new-sha',
    updateBranch: async () => {},
    closePullRequest: async () => {},
    deleteBranch: async () => {},
    ...overrides,
  }
}

function clients(overrides: Partial<ProviderPurgeClients> = {}): ProviderPurgeClients {
  return { issues: issues(), content: content(), ...overrides }
}

async function planned(
  over: Partial<ProviderPurgeClients> = {},
  input: { keptPasses?: readonly string[] } = {},
) {
  const built = clients(over)
  const plan = await planProviderPurge(built, {
    targets: [backend, frontend],
    ledgerIssues: [],
    keptIssues: [],
    keptPasses: input.keptPasses ?? [],
    stamp: '20260812120000',
  })
  return { clients: built, plan }
}

describe('planProviderPurge', () => {
  it('collects a repository it cannot read instead of throwing out of the preview', async () => {
    // A 403 from an org-restricted token, a 404 on a repository the credential cannot see, or an
    // HTML body from a proxy: all of them arrive here as a throw, and the plan is printed BEFORE the
    // board plan an operator is reading this to grade.
    const { plan } = await planned({
      content: content({
        head: async (target) => {
          if (target.repo === 'catalog-web') throw new Error('HTTP 403 SAML enforcement')
          return { branch: 'main', commitSha: 'tip-sha' }
        },
      }),
    })
    expect(plan.repos).toHaveLength(1)
    expect(plan.unreadableRepos).toHaveLength(1)
    expect(plan.unreadableRepos[0]?.problem).toContain('SAML enforcement')
    // And it is named in the preview, under the heading the issue half already uses for this.
    expect(formatProviderPlan(plan)).toContain('acme/catalog-web')
  })

  // An unread repository is not an empty one: it holds whatever it held, and reporting the purge as
  // done would be the "clean board plus a built-out repository" state this flag exists against.
  it('fails the purge over a repository it could not read', async () => {
    const { clients: built, plan } = await planned({
      content: content({
        head: async () => {
          throw new Error('HTTP 404')
        },
      }),
    })
    const report = await runProviderPurge(built, plan)
    expect(providerPurgeSucceeded(report)).toBe(false)
    expect(formatProviderReport(report)).toContain('HTTP 404')
  })

  it('refuses to empty a repository with no README, in the plan rather than mid-write', async () => {
    const { plan } = await planned({
      content: content({ rootEntries: async () => ['src', 'Dockerfile'] }),
    })
    expect(formatProviderPlan(plan)).toContain('REFUSES to empty it')
  })
})

describe('formatProviderReport', () => {
  // The tree was already clean, so no commit is written; the branch and the pull request still go.
  // A line reading "already empty, so nothing was written" over both is the report telling an
  // operator the opposite of what just happened, on the one surface they have for grading it.
  it('names the branches and pull requests it settled on a repository whose tree was clean', async () => {
    const { clients: built, plan } = await planned()
    const report = await runProviderPurge(built, plan)
    const text = formatProviderReport(report)
    expect(text).toContain('1 branch(es) deleted')
    expect(text).toContain('1 pull request(s) closed')
    expect(text).toContain('no commit was written')
  })

  it('names them on a repository whose emptying REFUSED, too', async () => {
    const { clients: built, plan } = await planned({
      content: content({
        rootEntries: async () => ['README.md', 'src'],
        commitKeepingOnly: async () => {
          throw new Error('tree write refused')
        },
      }),
    })
    const report = await runProviderPurge(built, plan)
    const text = formatProviderReport(report)
    expect(text).toContain('REFUSED')
    expect(text).toContain('1 branch(es) deleted')
  })
})

describe('the passes a reset keeps', () => {
  // Files and issues are per-pass; the repositories are not. Keeping one pass's ledger says it may
  // be resumed and emptying the repositories says it may not, so the consequence is stated in both
  // the preview (which is where it can still be acted on) and the report.
  it('states that a kept pass is no longer resumable once the shared repositories go', async () => {
    const { clients: built, plan } = await planned({}, { keptPasses: ['20260809175530'] })
    expect(formatProviderPlan(plan)).toContain('20260809175530')
    expect(formatProviderPlan(plan)).toContain('will no longer be resumable')
    const report = await runProviderPurge(built, plan)
    expect(formatProviderReport(report)).toContain('are no longer resumable')
  })

  it('says nothing about kept passes when there are none', async () => {
    const { plan } = await planned()
    expect(formatProviderPlan(plan)).not.toContain('resumable')
  })
})
