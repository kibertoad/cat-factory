import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PR_HEAD_REF, cloneRepo, fetchPullRequestHead, pullHeadRefspec } from '../src/git.js'

const exec = promisify(execFile)

// Real-git coverage for the pr-reviewer PR-HEAD prefetch: after the base (single-branch) checkout,
// the harness fetches the reviewed PR's synthetic head ref (`refs/pull/<n>/head` on GitHub,
// `refs/merge-requests/<n>/head` on GitLab — neither part of a normal clone) into `origin/pr-head`
// so the read-only reviewer can read files the PR ADDS (absent from the base checkout). A local
// file:// origin needs no token. Proves the ref becomes readable, that a missing PR is
// warn-and-skipped (never fatal), and that the base checkout stays put.

describe('pullHeadRefspec', () => {
  it('maps a GitHub pull ref onto origin/pr-head, forced', () => {
    expect(pullHeadRefspec(123, 'github')).toBe(`+refs/pull/123/head:${PR_HEAD_REF}`)
  })
  it('maps a GitLab merge-request ref onto origin/pr-head, forced', () => {
    expect(pullHeadRefspec(123, 'gitlab')).toBe(`+refs/merge-requests/123/head:${PR_HEAD_REF}`)
  })
})

describe('fetchPullRequestHead', () => {
  let origin: string
  let work: string
  const g = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
    exec('git', args, { cwd })
  const repo = (cloneUrl: string) => ({ owner: 'o', name: 'r', baseBranch: 'main', cloneUrl })

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'prhead-origin-'))
    await g(origin, 'init', '-b', 'main')
    await g(origin, 'config', 'user.email', 'o@e.com')
    await g(origin, 'config', 'user.name', 'Origin')
    await writeFile(join(origin, 'file.txt'), 'base\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base')
    // A PR head commit that ADDS a file — off main and never merged, so it is unreachable from the
    // base checkout until the synthetic pull ref is fetched.
    await g(origin, 'checkout', '-b', 'pr-branch')
    await writeFile(join(origin, 'added.txt'), 'proposed\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'add proposed file')
    const headSha = (await g(origin, 'rev-parse', 'HEAD')).stdout.trim()
    // Publish it as the host would: GitHub `refs/pull/<n>/head`, GitLab `refs/merge-requests/<n>/head`.
    await g(origin, 'update-ref', 'refs/pull/7/head', headSha)
    await g(origin, 'update-ref', 'refs/merge-requests/9/head', headSha)
    await g(origin, 'checkout', 'main')
    await g(origin, 'branch', '-D', 'pr-branch')
    work = await mkdtemp(join(tmpdir(), 'prhead-work-'))
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  async function cloneBase(): Promise<void> {
    // Single-branch clone of main only — exactly what a pr-reviewer run starts from, so the pull
    // ref (and the file it adds) is NOT present until fetched.
    await cloneRepo({ repo: repo(origin), ghToken: 'unused-for-file-origin', dir: work })
  }

  it('fetches the GitHub PR head into origin/pr-head so the proposed code becomes readable', async () => {
    await cloneBase()
    // The added file is absent from the base checkout before the fetch.
    await expect(g(work, 'show', 'origin/pr-head:added.txt')).rejects.toThrow()

    const fetched = await fetchPullRequestHead({
      dir: work,
      number: 7,
      provider: 'github',
      ghToken: 'unused-for-file-origin',
    })
    expect(fetched).toBe(true)
    // Now readable: the head commit + the file the PR adds are visible via the tracking ref.
    const show = (await g(work, 'show', 'origin/pr-head:added.txt')).stdout
    expect(show).toContain('proposed')
    // The base checkout's own HEAD is untouched (still on main; no added file in the working tree).
    expect((await g(work, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('main')
  })

  it('fetches the GitLab merge-request head into origin/pr-head', async () => {
    await cloneBase()
    const fetched = await fetchPullRequestHead({
      dir: work,
      number: 9,
      provider: 'gitlab',
      ghToken: 'unused-for-file-origin',
    })
    expect(fetched).toBe(true)
    expect((await g(work, 'show', 'origin/pr-head:added.txt')).stdout).toContain('proposed')
  })

  it('warn-and-skips a PR whose head ref does not exist (best-effort, never fatal)', async () => {
    await cloneBase()
    const skipped: string[] = []
    const fetched = await fetchPullRequestHead({
      dir: work,
      number: 999,
      provider: 'github',
      ghToken: 'unused-for-file-origin',
      onSkip: (reason) => skipped.push(reason),
    })
    expect(fetched).toBe(false)
    expect(skipped).toHaveLength(1)
    // The base checkout is unaffected: no pr-head ref was created.
    await expect(g(work, 'rev-parse', 'origin/pr-head')).rejects.toThrow()
  })
})
