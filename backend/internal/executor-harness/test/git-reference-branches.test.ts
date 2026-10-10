import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REFERENCE_WORKTREE_DIR, cloneRepo, fetchReferenceBranches } from '../src/git.js'

const exec = promisify(execFile)

// Real-git coverage for the apriori-branches REFERENCE-mode fetch: after the primary (shallow,
// single-branch) checkout, the harness fetches each named branch into its `origin/<b>` ref so the
// agent can read it. A local file:// origin needs no token. Proves the ref becomes readable, that a
// missing branch is warn-and-skipped (never fatal), and that the primary checkout stays put.

describe('fetchReferenceBranches', () => {
  let origin: string
  let work: string
  const g = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
    exec('git', args, { cwd })
  const repo = (cloneUrl: string) => ({ owner: 'o', name: 'r', baseBranch: 'main', cloneUrl })

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'ref-origin-'))
    await g(origin, 'init', '-b', 'main')
    await g(origin, 'config', 'user.email', 'o@e.com')
    await g(origin, 'config', 'user.name', 'Origin')
    await writeFile(join(origin, 'file.txt'), 'base\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base')
    // A spike branch with a commit not on main — the reference the agent will read.
    await g(origin, 'checkout', '-b', 'spike/prior-art')
    await writeFile(join(origin, 'spike.txt'), 'idea\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'spike')
    await g(origin, 'checkout', 'main')
    work = await mkdtemp(join(tmpdir(), 'ref-work-'))
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  async function cloneMain(): Promise<void> {
    // Shallow single-branch clone of main only — exactly what a coding/explore run starts from,
    // so the spike branch is NOT present until fetched.
    await cloneRepo({ repo: repo(origin), ghToken: 'unused-for-file-origin', dir: work })
  }

  it('fetches a reference branch into origin/<b> so it becomes readable', async () => {
    await cloneMain()
    // Not present before the fetch.
    await expect(g(work, 'rev-parse', 'origin/spike/prior-art')).rejects.toThrow()

    const fetched = await fetchReferenceBranches({
      dir: work,
      branches: ['spike/prior-art'],
      ghToken: 'unused-for-file-origin',
    })
    expect(fetched).toEqual(['spike/prior-art'])
    // Now readable: the spike commit + its file are visible via the tracking ref.
    const log = (await g(work, 'log', '--oneline', 'origin/spike/prior-art')).stdout
    expect(log).toContain('spike')
    const show = (await g(work, 'show', 'origin/spike/prior-art:spike.txt')).stdout
    expect(show).toContain('idea')
    // The checkout's own HEAD is untouched (still on main; no spike file in the working tree).
    expect((await g(work, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('main')
  })

  it('excludes the suggested reference-worktree dir so a checked-out ref is never staged', async () => {
    await cloneMain()
    await fetchReferenceBranches({
      dir: work,
      branches: ['spike/prior-art'],
      ghToken: 'unused-for-file-origin',
    })
    // The dedicated worktree prefix is added to the per-clone exclude.
    const exclude = await readFile(join(work, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain(`${REFERENCE_WORKTREE_DIR}/`)
    // Check the reference branch out as a worktree exactly as the prompt suggests, then confirm a
    // broad `git add -A` does NOT stage it (no stray embedded gitlink lands in the agent's commit).
    await g(work, 'worktree', 'add', `${REFERENCE_WORKTREE_DIR}/spike`, 'origin/spike/prior-art')
    await g(work, 'add', '-A')
    const staged = (await g(work, 'diff', '--cached', '--name-only')).stdout.trim()
    expect(staged).toBe('')
  })

  it('warn-and-skips a branch that does not exist, keeping the others', async () => {
    await cloneMain()
    const skipped: { branch: string; reason: string }[] = []
    const fetched = await fetchReferenceBranches({
      dir: work,
      branches: ['spike/prior-art', 'does/not-exist'],
      ghToken: 'unused-for-file-origin',
      onSkip: (branch, reason) => skipped.push({ branch, reason }),
    })
    expect(fetched).toEqual(['spike/prior-art'])
    expect(skipped.map((s) => s.branch)).toEqual(['does/not-exist'])
  })

  it('is a no-op for an empty branch list', async () => {
    await cloneMain()
    expect(await fetchReferenceBranches({ dir: work, branches: [], ghToken: 't' })).toEqual([])
  })
})
