import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanKeepPatterns, headCommit, prepareExistingCheckout } from '../src/git.js'

const exec = promisify(execFile)

// Real-git coverage for the PERSISTENT-checkout path: the first call clones into a stable
// dir, later calls reuse it (clean-sweep + fetch + switch branch) so a run never re-clones
// from scratch. Uses a local file:// origin so it needs no network/token (the token is only
// added to https remotes). The reuse-detection compares the origin URL prepareExistingCheckout
// itself set on the first clone, so it matches deterministically regardless of path slashes.

describe('prepareExistingCheckout', () => {
  let origin: string
  let work: string
  const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })
  const repo = (cloneUrl: string) => ({ owner: 'o', name: 'r', baseBranch: 'main', cloneUrl })

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'persist-origin-'))
    await g(origin, 'init', '-b', 'main')
    await g(origin, 'config', 'user.email', 'o@e.com')
    await g(origin, 'config', 'user.name', 'Origin')
    await writeFile(join(origin, 'file.txt'), 'base\n', 'utf8')
    // Ignore build artifacts + dependency caches so the sweep can prove it keeps deps.
    await writeFile(join(origin, '.gitignore'), '*.log\nnode_modules/\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base')
    work = await mkdtemp(join(tmpdir(), 'persist-work-'))
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('clones on first use into the stable dir and checks out the branch', async () => {
    await prepareExistingCheckout({
      dir: work,
      repo: repo(origin),
      ghToken: 'unused-for-file-origin',
      branch: 'main',
      baseBranch: 'main',
      existing: true,
    })
    expect(existsSync(join(work, 'file.txt'))).toBe(true)
    const tip = (await exec('git', ['rev-parse', 'main'], { cwd: origin })).stdout.trim()
    expect(await headCommit(work)).toBe(tip)
  })

  it('reuses the checkout: drops edits/untracked/ignored but KEEPS dependency caches, and advances to the new tip', async () => {
    // node_modules is one of the default kept patterns.
    expect(cleanKeepPatterns({})).toContain('node_modules')

    // First use → clone.
    await prepareExistingCheckout({
      dir: work,
      repo: repo(origin),
      ghToken: 't',
      branch: 'main',
      baseBranch: 'main',
      existing: true,
    })

    // Dirty the tree the way a prior run would have left it.
    await writeFile(join(work, 'file.txt'), 'LOCAL EDIT\n', 'utf8') // tracked edit
    await writeFile(join(work, 'scratch.sh'), 'echo hi\n', 'utf8') // untracked scratch
    await writeFile(join(work, 'debug.log'), 'noise\n', 'utf8') // ignored artifact
    await mkdir(join(work, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(
      join(work, 'node_modules', 'left-pad', 'index.js'),
      'module.exports=1\n',
      'utf8',
    )

    // Origin advances with a new commit on a non-overlapping file.
    await writeFile(join(origin, 'added.txt'), 'added\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'advance')
    const newTip = (await exec('git', ['rev-parse', 'main'], { cwd: origin })).stdout.trim()

    // Reuse the same dir.
    await prepareExistingCheckout({
      dir: work,
      repo: repo(origin),
      ghToken: 't',
      branch: 'main',
      baseBranch: 'main',
      existing: true,
    })

    // The tracked edit was reset, the scratch + ignored files removed...
    expect((await exec('git', ['show', 'HEAD:file.txt'], { cwd: work })).stdout).toContain('base')
    expect(existsSync(join(work, 'scratch.sh'))).toBe(false)
    expect(existsSync(join(work, 'debug.log'))).toBe(false)
    // ...the dependency cache was KEPT...
    expect(existsSync(join(work, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
    // ...and the checkout advanced to the new origin tip (no re-clone needed).
    expect(await headCommit(work)).toBe(newTip)
    expect(existsSync(join(work, 'added.txt'))).toBe(true)
  })

  it('creates a fresh work branch off the base tip when the branch does not exist (existing:false)', async () => {
    await prepareExistingCheckout({
      dir: work,
      repo: repo(origin),
      ghToken: 't',
      branch: 'cat-factory/blk',
      baseBranch: 'main',
      existing: false,
    })
    const branch = (
      await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: work })
    ).stdout.trim()
    expect(branch).toBe('cat-factory/blk')
    const baseTip = (await exec('git', ['rev-parse', 'main'], { cwd: origin })).stdout.trim()
    expect(await headCommit(work)).toBe(baseTip)
  })

  it('re-clones when the dir holds a DIFFERENT repo (cross-repo guard)', async () => {
    // First prepare repo A in the dir.
    await prepareExistingCheckout({
      dir: work,
      repo: repo(origin),
      ghToken: 't',
      branch: 'main',
      baseBranch: 'main',
      existing: true,
    })
    // A second origin (different repo) with a distinctive file.
    const origin2 = await mkdtemp(join(tmpdir(), 'persist-origin2-'))
    try {
      await g(origin2, 'init', '-b', 'main')
      await g(origin2, 'config', 'user.email', 'o2@e.com')
      await g(origin2, 'config', 'user.name', 'Origin2')
      await writeFile(join(origin2, 'OTHER.txt'), 'other repo\n', 'utf8')
      await g(origin2, 'add', '-A')
      await g(origin2, 'commit', '-m', 'base2')

      await prepareExistingCheckout({
        dir: work,
        repo: repo(origin2),
        ghToken: 't',
        branch: 'main',
        baseBranch: 'main',
        existing: true,
      })
      // The dir was re-cloned from repo B (its file is present, repo A's is gone).
      expect(existsSync(join(work, 'OTHER.txt'))).toBe(true)
      expect(existsSync(join(work, 'file.txt'))).toBe(false)
    } finally {
      await rm(origin2, { recursive: true, force: true })
    }
  })

  it('resumes a work branch (existing:true) at ITS tip, not the base tip, when base != branch', async () => {
    // A work branch carrying a commit the base (main) does not have, cut off the base.
    await g(origin, 'checkout', '-b', 'cat-factory/blk')
    await writeFile(join(origin, 'work.txt'), 'resumed work\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'work-commit')
    const workTip = (
      await exec('git', ['rev-parse', 'cat-factory/blk'], { cwd: origin })
    ).stdout.trim()
    const baseTip = (await exec('git', ['rev-parse', 'main'], { cwd: origin })).stdout.trim()
    expect(workTip).not.toBe(baseTip)
    await g(origin, 'checkout', 'main')

    // Resume that branch with a DISTINCT base — the base is also fetched (for downstream
    // diff/merge), which must NOT clobber the checkout target via FETCH_HEAD.
    await prepareExistingCheckout({
      dir: work,
      repo: repo(origin),
      ghToken: 't',
      branch: 'cat-factory/blk',
      baseBranch: 'main',
      existing: true,
    })
    // Checked out the work branch at its OWN tip (resumed commits preserved), not base.
    expect(await headCommit(work)).toBe(workTip)
    expect(existsSync(join(work, 'work.txt'))).toBe(true)
    // ...and origin/main was refreshed too, so downstream base diff/merge has it.
    const originMain = (
      await exec('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: work })
    ).stdout.trim()
    expect(originMain).toBe(baseTip)
  })
})
