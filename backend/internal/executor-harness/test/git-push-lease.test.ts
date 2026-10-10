import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyPushRejection,
  describeGitFailure,
  pushBranch,
  unpublishedWorkBranchTip,
  workBranchLease,
} from '../src/git.js'
import { HarnessFailure } from '../src/failure.js'

const exec = promisify(execFile)

/**
 * A local path as a `file://` URL, which is how `--depth` reaches git at all: it warns
 * "--depth is ignored in local clones" and clones the whole history when handed a plain path.
 */
const fileUrl = (path: string): string => `file:///${path.replace(/\\/g, '/')}`

// Real-git coverage for the work-branch push, against a local bare repo (no network, and no token,
// since `authenticatedCloneUrl` only rewrites https URLs).
//
// WHY THESE TWO CASES ARE A PAIR. The harness checkpoint-pushes the agent's commits while it
// works, so it is its own competing writer: a commit is published within a minute of being made,
// and the agent is then free to amend it. Before the lease, the FINAL push of such a run was
// refused as a non-fast-forward and the whole run failed with its work already on the branch (a
// real acceptance-run failure). The lease fixes that WITHOUT becoming a blanket force, and only
// the pair proves it: case 1 shows our own rewrite lands, case 2 shows a second writer's commits
// still refuse the push. Either half alone would pass for a plain `--force`.
//
// The rejection SHAPES are asserted against git's real output rather than hand-written strings,
// because the whole classification rests on git printing a different label in the two cases
// (`(non-fast-forward)` when it HOLDS the remote tip we are not descended from, `(stale info)`
// when our lease is stale), a distinction no unit test over fixture text could keep honest.
//
// The checkout is cloned the way PRODUCTION clones it: `--depth 1 --branch <base>`, over a
// `file://` URL because git ignores `--depth` for a local path. That shape is load-bearing rather
// than incidental. A full clone's wildcard fetch refspec makes `git push` create
// `refs/remotes/origin/<work branch>`, and a single-branch clone's does not, so a lease read back
// from that ref armed in this test and NEVER armed in production, which is the acceptance-run
// failure the lease was written to fix (`pushBranch` now names the sha it pushes instead).

describe('pushBranch leasing', () => {
  let origin: string
  let work: string
  const BRANCH = 'cat-factory/task_1'
  const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })
  /** Commit subjects on the origin's copy of the work branch, newest first. */
  const originLog = async (): Promise<string[]> => {
    const { stdout } = await exec('git', ['log', '--format=%s', BRANCH], { cwd: origin }).catch(
      () => ({ stdout: '' }),
    )
    return stdout.split('\n').filter(Boolean)
  }
  const commit = async (dir: string, file: string, body: string, message: string) => {
    await writeFile(join(dir, file), body, 'utf8')
    await g(dir, 'add', '-A')
    await g(dir, 'commit', '-m', message)
  }
  const push = (dir: string, expectRemoteSha?: string) =>
    pushBranch(
      dir,
      BRANCH,
      'unused-for-local-origin',
      undefined,
      expectRemoteSha ? { expectRemoteSha } : {},
    )

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'push-origin-'))
    await g(origin, 'init', '--bare', '-b', 'main')
    const seed = await mkdtemp(join(tmpdir(), 'push-seed-'))
    await g(seed, 'init', '-b', 'main')
    await g(seed, 'config', 'user.email', 'seed@example.com')
    await g(seed, 'config', 'user.name', 'seed')
    await commit(seed, 'README.md', '# base\n', 'base')
    await g(seed, 'remote', 'add', 'origin', origin)
    await g(seed, 'push', '-u', 'origin', 'main')
    await rm(seed, { recursive: true, force: true })
    // The agent's checkout, cloned exactly as `prepareCodingCheckout` clones a fresh coding run:
    // shallow, single branch, work branch cut off the base.
    work = await mkdtemp(join(tmpdir(), 'push-work-'))
    await g(work, 'clone', '--depth', '1', '--branch', 'main', fileUrl(origin), '.')
    await g(work, 'config', 'user.email', 'agent@example.com')
    await g(work, 'config', 'user.name', 'agent')
    await g(work, 'checkout', '-b', BRANCH)
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('returns the sha it published, on the single-branch clone production uses', async () => {
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: work })
    expect(published).toBe(head.trim())
    expect(await originLog()).toEqual(['agent work', 'base'])
    // The ref the first implementation read this back from does not exist here, which is why the
    // push names the sha instead. Asserted so a "simplification" back to the tracking ref fails
    // rather than silently disarming every lease in production.
    const tracking = await exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${BRANCH}`], {
      cwd: work,
    }).catch(() => null)
    expect(tracking).toBeNull()
  })

  it('has nothing to publish at the pre-run tip, or at the tip it last published', async () => {
    // What makes the 60s checkpoint a LOSS WINDOW rather than a push rate. Without the second
    // condition the tick re-pushed an unchanged branch forever: an hour-long run committing eight
    // times spent ~60 authenticated round trips to say "Everything up-to-date" ~52 times.
    const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: work })
    const baseSha = base.trim()
    const tip = (publishedSha?: string): Promise<string | undefined> =>
      unpublishedWorkBranchTip({ dir: work, baseSha, publishedSha })
    // A pass that has committed nothing must leave NO branch behind: a zero-diff branch pushed here
    // is what a later retry resumes and then cannot open a PR for.
    expect(await tip(undefined)).toBeUndefined()
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    expect(await tip(undefined)).toBe(published)
    expect(await tip(published)).toBeUndefined()
    // And it wakes up again the moment the agent commits, so the durability guarantee is unchanged.
    await commit(work, 'more.ts', 'export const b = 1\n', 'agent work 2')
    expect(await tip(published)).not.toBeUndefined()
    expect(await tip(published)).not.toBe(published)
  })

  it('lands a rewrite of the checkpoint it published, and refuses the same push unleased', async () => {
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    expect(published).toBeDefined()
    // The agent validates AFTER committing (the delivery contract asks it to), fixes what it
    // found, and amends: the sequence that produced the original failure.
    await writeFile(join(work, 'src.ts'), 'export const a = 2\n', 'utf8')
    await g(work, 'commit', '-a', '--amend', '-m', 'agent work (fixed)')

    // Unleased, this is the failure being fixed: refused, and refused as a `local-rewrite`.
    const refused = await push(work).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(HarnessFailure)
    expect((refused as HarnessFailure).failureCause).toBe('branch-contended')
    expect(classifyPushRejection((refused as Error).message)).toBe('local-rewrite')
    expect(await originLog()).toEqual(['agent work', 'base'])

    // Leased against what THIS pass published, the rewrite lands.
    const republished = await push(work, published)
    expect(await originLog()).toEqual(['agent work (fixed)', 'base'])
    const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: work })
    expect(republished).toBe(head.trim())
  })

  it('refuses to overwrite a SECOND writer, lease or no lease', async () => {
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    // A concurrent dispatch for the same block, working in its own checkout, lands first.
    const other = await mkdtemp(join(tmpdir(), 'push-other-'))
    try {
      await g(other, 'clone', '--branch', BRANCH, origin, '.')
      await g(other, 'config', 'user.email', 'other@example.com')
      await g(other, 'config', 'user.name', 'other')
      await commit(other, 'other.ts', 'export const b = 1\n', 'other run work')
      await g(other, 'push', 'origin', BRANCH)

      // Our pass rewrites its own commit and pushes with the lease it is entitled to. The lease is
      // stale, so the other run's commit survives: the property the resume design leans on.
      await writeFile(join(work, 'src.ts'), 'export const a = 2\n', 'utf8')
      await g(work, 'commit', '-a', '--amend', '-m', 'agent work (fixed)')
      const refused = await push(work, published).catch((e: unknown) => e)
      expect(refused).toBeInstanceOf(HarnessFailure)
      expect((refused as HarnessFailure).failureCause).toBe('branch-contended')
      expect(classifyPushRejection((refused as Error).message)).toBe('remote-writer')
      expect(await originLog()).toEqual(['other run work', 'agent work', 'base'])
      // The operator gets the second-writer remedy, not the rewrite one.
      expect(describeGitFailure((refused as Error).message)).toMatch(/another writer advanced/i)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('withholds the lease from a rewrite that drops commits an EARLIER run published', async () => {
    // The lease alone does not bound the force to this pass's own commits, and this is the case
    // where it does not: a resumed run that has already landed one checkpoint holds a lease the
    // remote still honours, so a rewrite reaching BELOW the tip it resumed from would land and
    // take the earlier run's commits with it. The containment probe is what refuses it.
    await commit(work, 'src.ts', 'export const a = 1\n', 'earlier run work')
    await commit(work, 'more.ts', 'export const b = 1\n', 'earlier run work 2')
    await push(work)
    // This pass RESUMES that branch, exactly as `cloneExistingBranch` leaves it.
    const resumed = await mkdtemp(join(tmpdir(), 'push-resumed-'))
    try {
      await g(resumed, 'clone', '--branch', BRANCH, '--single-branch', fileUrl(origin), '.')
      await g(resumed, 'config', 'user.email', 'agent@example.com')
      await g(resumed, 'config', 'user.name', 'agent')
      const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: resumed })
      const baseSha = base.trim()
      await commit(resumed, 'new.ts', 'export const c = 1\n', 'this pass work')
      const published = await push(resumed)

      // The agent rebases/resets past the tip it resumed from and re-commits.
      await g(resumed, 'reset', '--hard', 'HEAD~2')
      await commit(resumed, 'new.ts', 'export const c = 2\n', 'this pass rewritten')
      const withheld: string[] = []
      const lease = await workBranchLease({
        dir: resumed,
        branch: BRANCH,
        baseSha,
        publishedSha: published,
        onWithheld: (probe) => withheld.push(probe),
      })
      expect(lease).toEqual({})
      expect(withheld).toEqual(['dropped'])

      // So the push goes out plain and git refuses it: the engine re-dispatches onto the branch as
      // it stands, and the earlier run's commits are still there.
      const refused = await push(resumed).catch((e: unknown) => e)
      expect((refused as HarnessFailure).failureCause).toBe('branch-contended')
      expect(await originLog()).toEqual([
        'this pass work',
        'earlier run work 2',
        'earlier run work',
        'base',
      ])

      // And the lease WOULD have landed it, which is the whole reason the probe exists rather than
      // the lease being trusted on its own.
      await push(resumed, published)
      expect(await originLog()).toEqual(['this pass rewritten', 'earlier run work', 'base'])
    } finally {
      await rm(resumed, { recursive: true, force: true })
    }
    // Two checkouts and four real pushes: the slowest case in the file, and past the 5s default.
  }, 30_000)

  it('withholds the lease when containment cannot be established', async () => {
    // An unreadable probe and a dropped tip are different facts and only one of them is a rewrite,
    // but they earn the same disposition: withholding costs a refused push, trusting costs commits.
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    const withheld: string[] = []
    const lease = await workBranchLease({
      dir: work,
      branch: BRANCH,
      baseSha: 'f'.repeat(40),
      publishedSha: published,
      onWithheld: (probe) => withheld.push(probe),
    })
    expect(lease).toEqual({})
    expect(withheld).toEqual(['unreadable'])
  })

  it('reports a refused push ONCE, not twice', async () => {
    // `execFile` already folds stderr into its rejection message, so appending it again printed
    // every git failure's output twice and read as two push attempts.
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    await push(work)
    await g(work, 'commit', '-a', '--amend', '-m', 'rewritten')
    const refused = await push(work).catch((e: unknown) => e)
    const message = (refused as Error).message
    expect(message.match(/\[rejected]/g)).toHaveLength(1)
  })
})
