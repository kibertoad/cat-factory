import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BootstrapTargetSpec, PrSpec, RepoSpec } from './job.js'

const exec = promisify(execFile)

// Git + GitHub helpers. The installation token is embedded in the clone URL so
// the same authenticated remote is reused for push; the token is never logged
// (errors surface stderr, so we keep the token out of any echoed command).

const GIT_AUTHOR = 'cat-factory[bot]'
const GIT_EMAIL = 'cat-factory[bot]@users.noreply.github.com'

/** Build an authenticated HTTPS clone URL from a plain one + an installation token. */
export function authenticatedCloneUrl(cloneUrl: string, ghToken: string): string {
  // https://github.com/owner/name.git → https://x-access-token:TOKEN@github.com/...
  return cloneUrl.replace(/^https:\/\//, `https://x-access-token:${ghToken}@`)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/** Clone `repo`'s base branch (shallow) into `dir` and set commit identity. */
export async function cloneRepo(opts: {
  repo: RepoSpec
  ghToken: string
  dir: string
}): Promise<void> {
  const url = authenticatedCloneUrl(opts.repo.cloneUrl, opts.ghToken)
  await exec('git', ['clone', '--depth', '1', '--branch', opts.repo.baseBranch, url, opts.dir])
  await git(opts.dir, ['config', 'user.name', GIT_AUTHOR])
  await git(opts.dir, ['config', 'user.email', GIT_EMAIL])
}

/** Create and switch to the work branch. */
export async function createBranch(dir: string, branch: string): Promise<void> {
  await git(dir, ['checkout', '-b', branch])
}

/** Stage everything and commit; returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ['add', '-A'])
  const status = await git(dir, ['status', '--porcelain'])
  if (status.trim() === '') return false
  await git(dir, ['commit', '-m', message])
  return true
}

/** Push the work branch to origin (already authenticated from the clone URL). */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  await git(dir, ['push', '-u', 'origin', branch])
}

/**
 * Reset the working tree's git history to a single bootstrap commit and push it
 * to the (initially empty) target repository's default branch. Wiping `.git`
 * before re-initialising means the new repo starts clean — it inherits the
 * bootstrapped *contents* of the reference architecture, not its commit history.
 */
export async function reinitAndPush(opts: {
  dir: string
  target: BootstrapTargetSpec
  ghToken: string
  message: string
}): Promise<void> {
  await rm(join(opts.dir, '.git'), { recursive: true, force: true })
  await git(opts.dir, ['init'])
  // Start the history on the target's default branch (init may default to master).
  await git(opts.dir, ['checkout', '-b', opts.target.defaultBranch])
  await git(opts.dir, ['config', 'user.name', GIT_AUTHOR])
  await git(opts.dir, ['config', 'user.email', GIT_EMAIL])
  await git(opts.dir, ['add', '-A'])
  await git(opts.dir, ['commit', '-m', opts.message])
  const url = authenticatedCloneUrl(opts.target.cloneUrl, opts.ghToken)
  await git(opts.dir, ['remote', 'add', 'origin', url])
  await git(opts.dir, ['push', '-u', 'origin', opts.target.defaultBranch])
}

/** Open a PR via the GitHub REST API; returns its html_url. */
export async function openPullRequest(opts: {
  owner: string
  name: string
  ghToken: string
  head: string
  base: string
  pr: PrSpec
  apiBase?: string
}): Promise<string> {
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  const res = await fetch(`${apiBase}/repos/${opts.owner}/${opts.name}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.ghToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cat-factory-implementer',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: opts.pr.title,
      head: opts.head,
      base: opts.base,
      body: opts.pr.body,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to open PR (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }
  const body = (await res.json()) as { html_url?: string }
  if (!body.html_url) throw new Error('GitHub did not return a PR url')
  return body.html_url
}
