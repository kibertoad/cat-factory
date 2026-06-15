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

// Per-git-command wall-clock ceiling. A single git op (clone/push over a flaky
// network) must not hang the job indefinitely; the job's overall watchdog
// (see runner.ts) is the outer bound, this stops one wedged command first.
const GIT_TIMEOUT_MS = 10 * 60_000

/** Build an authenticated HTTPS clone URL from a plain one + an installation token. */
export function authenticatedCloneUrl(cloneUrl: string, ghToken: string): string {
  // https://github.com/owner/name.git → https://x-access-token:TOKEN@github.com/...
  return cloneUrl.replace(/^https:\/\//, `https://x-access-token:${ghToken}@`)
}

/**
 * Run one git command. `signal` (the job watchdog's) and a per-command timeout
 * both abort a wedged process, so neither a hung clone nor a stalled push can
 * keep the container running forever.
 */
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
  return stdout
}

/** Clone `repo`'s base branch (shallow) into `dir` and set commit identity. */
export async function cloneRepo(opts: {
  repo: RepoSpec
  ghToken: string
  dir: string
  signal?: AbortSignal
}): Promise<void> {
  const url = authenticatedCloneUrl(opts.repo.cloneUrl, opts.ghToken)
  await exec('git', ['clone', '--depth', '1', '--branch', opts.repo.baseBranch, url, opts.dir], {
    timeout: GIT_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  await git(opts.dir, ['config', 'user.name', GIT_AUTHOR], opts.signal)
  await git(opts.dir, ['config', 'user.email', GIT_EMAIL], opts.signal)
}

/** Create and switch to the work branch. */
export async function createBranch(
  dir: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(dir, ['checkout', '-b', branch], signal)
}

/** Stage everything and commit; returns false when there was nothing to commit. */
export async function commitAll(
  dir: string,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await git(dir, ['add', '-A'], signal)
  const status = await git(dir, ['status', '--porcelain'], signal)
  if (status.trim() === '') return false
  await git(dir, ['commit', '-m', message], signal)
  return true
}

/** Push the work branch to origin (already authenticated from the clone URL). */
export async function pushBranch(dir: string, branch: string, signal?: AbortSignal): Promise<void> {
  await git(dir, ['push', '-u', 'origin', branch], signal)
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
  signal?: AbortSignal
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
    // Bound on the watchdog so a hung GitHub call can't stall the job.
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to open PR (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }
  const body = (await res.json()) as { html_url?: string }
  if (!body.html_url) throw new Error('GitHub did not return a PR url')
  return body.html_url
}
