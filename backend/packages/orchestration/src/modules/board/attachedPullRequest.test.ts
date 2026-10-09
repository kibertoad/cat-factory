import type { OpenedPullRequest, RepoFiles, RunRepoContext } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { resolveAttachedPullRequest } from './attachedPullRequest.js'

const openPr = (over: Partial<OpenedPullRequest> = {}): OpenedPullRequest => ({
  repoGithubId: 1,
  number: 42,
  githubId: 4200,
  title: 'Add login',
  state: 'open',
  headRef: 'feature/login',
  baseRef: 'main',
  headSha: 'abc',
  merged: false,
  author: 'someone',
  updatedAt: null,
  syncedAt: 0,
  url: 'https://github.com/o/r/pull/42',
  crossRepository: false,
  ...over,
})

function depsFor(pr: OpenedPullRequest | null, over: Partial<RunRepoContext> = {}) {
  const context: RunRepoContext = {
    repo: { getPullRequest: async () => pr } as unknown as RepoFiles,
    baseBranch: 'main',
    repoId: 'repo_1',
    owner: 'o',
    name: 'r',
    ...over,
  }
  return { resolveRunRepoContext: async () => context }
}

async function refusalOf(promise: Promise<unknown>): Promise<ValidationError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ValidationError)
  return error as ValidationError
}

const attach = (
  deps: Parameters<typeof resolveAttachedPullRequest>[0],
  fields: Parameters<typeof resolveAttachedPullRequest>[4] = { prNumber: 42 },
  taskType = 'resolve-conflicts',
) => resolveAttachedPullRequest(deps, 'ws', 'blk_svc', taskType, fields)

describe('resolveAttachedPullRequest', () => {
  it('attaches an open same-repo PR as the block pull request, canonicalising its url', async () => {
    const attached = await attach(depsFor(openPr()))
    expect(attached).toEqual({
      fields: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' },
      pullRequest: { url: 'https://github.com/o/r/pull/42', number: 42, branch: 'feature/login' },
    })
  })

  it('resolves a URL-only reference by its number', async () => {
    const attached = await attach(depsFor(openPr()), { prUrl: 'https://github.com/O/R/pull/42' })
    expect(attached?.pullRequest.number).toBe(42)
  })

  it('leaves every other task type alone', async () => {
    expect(await attach(depsFor(openPr()), { prNumber: 42 }, 'review')).toBeNull()
    expect(await attach(depsFor(openPr()), undefined, 'feature')).toBeNull()
  })

  it('refuses a task that names no pull request', async () => {
    const error = await refusalOf(attach(depsFor(openPr()), {}))
    expect(error.details).toMatchObject({ reason: 'task_type_fields_invalid' })
  })

  it('refuses a PR whose head branch lives in a fork', async () => {
    const error = await refusalOf(attach(depsFor(openPr({ crossRepository: true }))))
    expect(error.details).toMatchObject({ reason: 'attached_pr_from_fork' })
    expect(error.message).toContain('fork')
  })

  it('refuses a closed PR and a merged one, saying which', async () => {
    const closed = await refusalOf(attach(depsFor(openPr({ state: 'closed' }))))
    expect(closed.details).toMatchObject({ reason: 'attached_pr_not_open', state: 'closed' })
    const merged = await refusalOf(attach(depsFor(openPr({ state: 'closed', merged: true }))))
    expect(merged.details).toMatchObject({ reason: 'attached_pr_not_open', state: 'merged' })
  })

  it('refuses a URL naming another repository than the service is linked to', async () => {
    const error = await refusalOf(
      attach(depsFor(openPr()), { prUrl: 'https://github.com/elsewhere/other/pull/42' }),
    )
    expect(error.details).toMatchObject({ reason: 'attached_pr_repo_mismatch', expected: 'o/r' })
  })

  it('refuses a PR the provider reports as absent', async () => {
    const error = await refusalOf(attach(depsFor(null)))
    expect(error.details).toMatchObject({ reason: 'attached_pr_not_found', prNumber: 42 })
  })

  it('refuses a PR targeting a branch other than the one the resolver merges in', async () => {
    const error = await refusalOf(attach(depsFor(openPr({ baseRef: 'release/1.2' }))))
    expect(error.details).toMatchObject({ reason: 'attached_pr_base_mismatch', expected: 'main' })
  })

  it('refuses when the provider does not say where the head branch lives', async () => {
    const error = await refusalOf(attach(depsFor(openPr({ crossRepository: undefined }))))
    expect(error.details).toMatchObject({ reason: 'attached_pr_unresolvable' })
  })

  it('refuses when no repository can be read rather than creating the task unchecked', async () => {
    const none = await refusalOf(attach({ resolveRunRepoContext: async () => null }))
    expect(none.details).toMatchObject({ reason: 'attached_pr_unresolvable' })
    const unwired = await refusalOf(attach({}))
    expect(unwired.details).toMatchObject({ reason: 'attached_pr_unresolvable' })
  })
})
