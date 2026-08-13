import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyPushRejection, describeGitFailure, pushBranch } from '../src/git.js'
import { HarnessFailure } from '../src/failure.js'

const exec = promisify(execFile)

// Real-git coverage for the work-branch push, against a local bare repo (no network, no token —
// `authenticatedCloneUrl` only rewrites https URLs).
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
// when our lease is stale) — a distinction no unit test over fixture text could keep honest.

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
    // The agent's checkout: base cloned, work branch cut off it — what `prepareCodingCheckout` leaves.
    work = await mkdtemp(join(tmpdir(), 'push-work-'))
    await g(work, 'clone', '--branch', 'main', origin, '.')
    await g(work, 'config', 'user.email', 'agent@example.com')
    await g(work, 'config', 'user.name', 'agent')
    await g(work, 'checkout', '-b', BRANCH)
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('returns the sha it published, read back from the remote-tracking ref', async () => {
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: work })
    expect(published).toBe(head.trim())
    expect(await originLog()).toEqual(['agent work', 'base'])
  })

  it('lands a rewrite of the checkpoint it published, and refuses the same push unleased', async () => {
    await commit(work, 'src.ts', 'export const a = 1\n', 'agent work')
    const published = await push(work)
    expect(published).toBeDefined()
    // The agent validates AFTER committing (the delivery contract asks it to), fixes what it
    // found, and amends — the sequence that produced the original failure.
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
